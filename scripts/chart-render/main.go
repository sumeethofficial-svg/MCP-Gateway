// chart-render: a small, dependency-free stand-in for `helm template`, used only to sanity-check the chart where
// the real Helm binary is not available. It implements the subset of Helm/Sprig functions the chart uses.
// It is NOT a replacement for `helm lint` / `helm template`; CI and the README use the real tool.
//
//	go run . -chart ../../charts/mcp-portal -values values.json [-release mcp-portal -namespace mcp-portal]
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/template"
)

type filesAPI struct{ root string }

func (f filesAPI) Get(name string) string {
	b, err := os.ReadFile(filepath.Join(f.root, name))
	if err != nil {
		panic(fmt.Sprintf("Files.Get %q: %v", name, err))
	}
	return string(b)
}

const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func toInt(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case string:
		var n int
		fmt.Sscanf(x, "%d", &n)
		return n
	case nil:
		return 0
	}
	panic(fmt.Sprintf("int: unsupported %T", v))
}

func isEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case bool:
		return !x
	case float64:
		return x == 0
	case int:
		return x == 0
	case []any:
		return len(x) == 0
	case map[string]any:
		return len(x) == 0
	}
	return false
}

func indent(n int, s string) string {
	pad := strings.Repeat(" ", n)
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = pad + l
	}
	return strings.Join(lines, "\n")
}

func main() {
	chart := flag.String("chart", "", "chart directory")
	valuesFile := flag.String("values", "", "merged values as JSON")
	release := flag.String("release", "mcp-portal", "release name")
	namespace := flag.String("namespace", "mcp-portal", "release namespace")
	flag.Parse()

	var values map[string]any
	raw, err := os.ReadFile(*valuesFile)
	check(err)
	check(json.Unmarshal(raw, &values))

	var chartMeta map[string]any
	{
		// Chart.yaml is flat key: value; parse the few fields we need.
		b, err := os.ReadFile(filepath.Join(*chart, "Chart.yaml"))
		check(err)
		chartMeta = map[string]any{}
		for _, line := range strings.Split(string(b), "\n") {
			if i := strings.Index(line, ":"); i > 0 && !strings.HasPrefix(line, " ") {
				chartMeta[strings.Title(strings.TrimSpace(line[:i]))] = strings.Trim(strings.TrimSpace(line[i+1:]), `"`)
			}
		}
	}

	root := map[string]any{
		"Values":       values,
		"Release":      map[string]any{"Name": *release, "Namespace": *namespace, "Service": "Helm", "IsInstall": true, "IsUpgrade": false, "Revision": 1},
		"Chart":        chartMeta,
		"Capabilities": map[string]any{"KubeVersion": map[string]any{"Version": "v1.31.0"}},
		"Files":        filesAPI{*chart},
	}

	tpl := template.New("root").Option("missingkey=default")
	funcs := template.FuncMap{}
	funcs["include"] = func(name string, data any) (string, error) {
		var buf bytes.Buffer
		err := tpl.ExecuteTemplate(&buf, name, data)
		return buf.String(), err
	}
	funcs["toYaml"] = func(v any) string { b, _ := json.Marshal(v); return string(b) } // JSON is valid YAML
	funcs["toJson"] = func(v any) string { b, _ := json.Marshal(v); return string(b) }
	funcs["quote"] = func(v any) string {
		if v == nil {
			return `""`
		}
		b, _ := json.Marshal(fmt.Sprint(v))
		return string(b)
	}
	funcs["squote"] = func(v any) string { return "'" + fmt.Sprint(v) + "'" }
	funcs["default"] = func(d any, v ...any) any {
		if len(v) == 0 || isEmpty(v[0]) {
			return d
		}
		return v[0]
	}
	funcs["empty"] = isEmpty
	funcs["hasKey"] = func(m map[string]any, k string) bool { _, ok := m[k]; return ok }
	funcs["dict"] = func(kv ...any) map[string]any {
		m := map[string]any{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[fmt.Sprint(kv[i])] = kv[i+1]
		}
		return m
	}
	funcs["list"] = func(v ...any) []any { return append([]any{}, v...) }
	funcs["append"] = func(l []any, v any) []any { return append(append([]any{}, l...), v) }
	funcs["concat"] = func(ls ...[]any) []any {
		out := []any{}
		for _, l := range ls {
			out = append(out, l...)
		}
		return out
	}
	funcs["regexReplaceAll"] = func(re, in, repl string) string { return regexp.MustCompile(re).ReplaceAllString(in, repl) }
	funcs["merge"] = func(dst map[string]any, srcs ...map[string]any) map[string]any {
		for _, src := range srcs {
			for k, v := range src {
				if _, ok := dst[k]; !ok {
					dst[k] = v
				}
			}
		}
		return dst
	}
	funcs["set"] = func(m map[string]any, k string, v any) map[string]any { m[k] = v; return m }
	funcs["join"] = func(sep string, l []any) string {
		s := make([]string, len(l))
		for i, x := range l {
			s[i] = fmt.Sprint(x)
		}
		return strings.Join(s, sep)
	}
	funcs["indent"] = func(n int, s string) string { return indent(n, s) }
	funcs["nindent"] = func(n int, s string) string { return "\n" + indent(n, s) }
	funcs["trunc"] = func(n int, s string) string {
		if len(s) > n {
			return s[:n]
		}
		return s
	}
	funcs["trimSuffix"] = func(suf, s string) string { return strings.TrimSuffix(s, suf) }
	funcs["b64enc"] = func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	funcs["b64dec"] = func(s string) (string, error) { b, err := base64.StdEncoding.DecodeString(s); return string(b), err }
	funcs["sha256sum"] = func(s string) string { h := sha256.Sum256([]byte(s)); return fmt.Sprintf("%x", h) }
	funcs["randAlphaNum"] = func(n int) string {
		out := make([]byte, n)
		for i := range out {
			j, _ := rand.Int(rand.Reader, big.NewInt(int64(len(alnum))))
			out[i] = alnum[j.Int64()]
		}
		return string(out)
	}
	funcs["int"] = toInt
	funcs["lookup"] = func(apiVersion, kind, ns, name string) map[string]any { return map[string]any{} } // no cluster
	funcs["required"] = func(msg string, v any) (any, error) {
		if isEmpty(v) {
			return nil, fmt.Errorf("%s", msg)
		}
		return v, nil
	}
	funcs["fail"] = func(msg string) (string, error) { return "", fmt.Errorf("%s", msg) }
	funcs["lower"] = strings.ToLower
	funcs["upper"] = strings.ToUpper
	funcs["ternary"] = func(a, b any, cond bool) any {
		if cond {
			return a
		}
		return b
	}
	tpl.Funcs(funcs)

	// Parse everything so that `define`s are visible everywhere, exactly as in Helm.
	var render []string
	check(filepath.WalkDir(filepath.Join(*chart, "templates"), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(*chart, p)
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if _, err := tpl.New(rel).Parse(string(b)); err != nil {
			return fmt.Errorf("parse %s: %w", rel, err)
		}
		base := filepath.Base(p)
		if !strings.HasPrefix(base, "_") && base != "NOTES.txt" {
			render = append(render, rel)
		}
		return nil
	}))
	sort.Strings(render)

	var out bytes.Buffer
	for _, rel := range render {
		var buf bytes.Buffer
		if err := tpl.ExecuteTemplate(&buf, rel, root); err != nil {
			fmt.Fprintf(os.Stderr, "render %s: %v\n", rel, err)
			os.Exit(1)
		}
		if strings.TrimSpace(buf.String()) == "" {
			continue
		}
		fmt.Fprintf(&out, "---\n# Source: %s\n%s\n", rel, strings.TrimSpace(buf.String()))
	}
	fmt.Print(out.String())
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
