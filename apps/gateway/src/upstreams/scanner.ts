import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Heuristic detection of "tool poisoning": instructions hidden in tool metadata that are
 * addressed to the model instead of describing the tool. The model reads descriptions as
 * trusted context, so a hostile upstream can steer it without ever being called.
 *
 * This is a tripwire, not a guarantee. It is one layer next to pinning (changes require
 * re-approval), permissions (a steered model still cannot call what the user may not),
 * and the agent's treatment of tool output as data. A hit quarantines the tool for admin
 * review rather than silently dropping it, so false positives are cheap.
 */

interface Rule {
  id: string;
  description: string;
  test: RegExp;
}

const RULES: Rule[] = [
  { id: "hidden-tag", description: "Contains a pseudo-markup block such as <IMPORTANT> or <system>", test: /<\s*\/?\s*(important|system|instructions?|secret|hidden|admin|override|note to (the )?(ai|assistant|model))\b/i },
  { id: "role-prefix", description: "Contains text styled as a system or assistant message", test: /(?:^|[.!?\n]\s*)(system|assistant|developer)\s*:/i },
  { id: "override-instructions", description: "Tells the model to ignore or override earlier instructions", test: /\b(ignore|disregard|forget|override|bypass)\b(?:[^.\n]|\.(?=\S)){0,50}\b(previous|prior|above|earlier|all|any|the user'?s?|your|system)\b(?:[^.\n]|\.(?=\S)){0,40}\b(instructions?|prompts?|rules?|requests?|messages?|guidelines?)\b/i },
  { id: "system-override", description: "Claims system-level authority", test: /\b(system\s+(override|notice|message|update)|admin(istrator)?\s+override|new\s+instructions?)\b/i },
  { id: "concealment", description: "Asks the model to hide something from the user", test: /\b(do\s*n['o]?t|never|without|must\s*n['o]?t)\b(?:[^.\n]|\.(?=\S)){0,20}\b(tell|mention|inform|notify|reveal|disclose|show|let)\b(?:[^.\n]|\.(?=\S)){0,40}\b(the\s+)?(user|human|person|anyone)\b/i },
  { id: "precondition-action", description: "Requires extra actions before the tool is used", test: /\bbefore\s+(using|calling|invoking|running|you\s+use)\s+(this|the)\s+tool\b(?:[^.\n]|\.(?=\S)){0,120}\b(call|use|invoke|read|fetch|collect|send|list|get)\b/i },
  { id: "cross-tool-directive", description: "Directs the model to use other tools", test: /\b(call|invoke|use|run)\b(?:[^.\n]|\.(?=\S)){0,40}\b(any|every|all|other|another|different|available)\b(?:[^.\n]|\.(?=\S)){0,40}\btools?\b/i },
  { id: "data-exfiltration", description: "Asks the model to relay credentials, emails or customer data into a parameter or to an outside address", test: /\b(send|pass|forward|post|upload|exfiltrate|transmit|leak|copy|include|put|collect|gather|attach|append)\b(?:[^.\n]|\.(?=\S)){0,80}\b(e-?mails?|passwords?|credentials?|secrets?|tokens?|api[ _-]?keys?|private keys?|customer (data|details|information))\b(?:[^.\n]|\.(?=\S)){0,80}\b(to|into|in|via|through)\b(?:[^.\n]|\.(?=\S)){0,40}\b(parameters?|arguments?|fields?|notes?|urls?|endpoints?|webhooks?)\b/i },
  { id: "mass-mutation", description: "Instructs bulk destructive changes", test: /\b(every|all)\s+(orders?|products?|users?|records?|tickets?)\b(?:[^.\n]|\.(?=\S)){0,60}\b(cancel|delete|remove|refund|mark|update)\w*/i },
  { id: "hidden-characters", description: "Contains invisible or bidirectional control characters", test: /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u0000-\u0008\u000B\u000C\u000E-\u001F]/ },
];

const MAX_SCANNED_LENGTH = 2000;

/** Collects every human-readable string the model will see for a tool. */
function modelVisibleText(tool: Tool): string {
  const parts: string[] = [tool.title ?? "", tool.description ?? ""];
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 8) return;
    const obj = node as Record<string, unknown>;
    for (const key of ["description", "title"]) if (typeof obj[key] === "string") parts.push(obj[key] as string);
    if (Array.isArray(obj.enum)) parts.push(...obj.enum.filter((v): v is string => typeof v === "string"));
    for (const value of Object.values(obj)) if (value && typeof value === "object") walk(value, depth + 1);
  };
  walk(tool.inputSchema, 0);
  return parts.filter(Boolean).join("\n");
}

export interface ScanFinding {
  id: string;
  description: string;
}

export function scanTool(tool: Tool): ScanFinding[] {
  const text = modelVisibleText(tool);
  const findings: ScanFinding[] = RULES.filter((rule) => rule.test.test(text)).map(({ id, description }) => ({ id, description }));
  if (text.length > MAX_SCANNED_LENGTH) findings.push({ id: "excessive-length", description: `Model-visible text is ${text.length} characters (limit ${MAX_SCANNED_LENGTH})` });
  return findings;
}

export function describeFindings(findings: ScanFinding[]): string {
  return findings.map((f) => f.description).join("; ");
}

/** Removes invisible/control characters and bounds length. Applied to anything shown to a model. */
export function sanitizeText(input: string | undefined, max: number): string {
  if (!input) return "";
  const cleaned = input
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
