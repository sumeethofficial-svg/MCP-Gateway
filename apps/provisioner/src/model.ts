/** Labels and annotations are the database: a store is a Namespace, and everything about it lives on that object. */
export const LABEL_STORE = "mcp-portal.io/store";
export const LABEL_STORE_ID = "mcp-portal.io/store-id";
export const LABEL_OWNER = "mcp-portal.io/owner";
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const MANAGER = "mcp-provisioner";

export const ANN_NAME = "mcp-portal.io/display-name";
export const ANN_OWNER_EMAIL = "mcp-portal.io/owner-email";
export const ANN_PHASE = "mcp-portal.io/phase";
export const ANN_REASON = "mcp-portal.io/reason";
export const ANN_CREATED = "mcp-portal.io/created-at";
export const ANN_READY = "mcp-portal.io/ready-at";

export type Phase = "Provisioning" | "Ready" | "Failed" | "Deleting";

export interface StoreView {
  id: string;
  name: string;
  namespace: string;
  phase: Phase;
  /** Why a store is Failed (or what it is waiting on). Safe to show to a user. */
  reason: string | null;
  url: string;
  ownerId: string;
  ownerEmail: string | null;
  createdAt: string;
}

/** The subset of a Namespace object the provisioner reads. */
export interface NamespaceObject {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
  };
}

/** DNS-1123 label, short enough that "<prefix><id>" (a namespace) and "store-<id>" (a gateway slug, max 24) both fit. */
export const STORE_ID = /^[a-z0-9]([a-z0-9-]{0,16}[a-z0-9])?$/;

/** Words that would be confusing or dangerous as a store id. */
const RESERVED = new Set(["default", "platform", "store", "kube-system", "kube-public", "kube-node-lease", "admin", "gateway", "api", "www"]);

export function validateStoreId(id: string): string | undefined {
  if (!STORE_ID.test(id)) return "Store id must be 1-18 characters: lowercase letters, digits and single hyphens, starting and ending with a letter or digit";
  if (id.includes("--")) return "Store id must not contain two hyphens in a row";
  if (RESERVED.has(id)) return `"${id}" is reserved`;
  return undefined;
}

export const toView = (ns: NamespaceObject, scheme: string, baseDomain: string): StoreView | undefined => {
  const l = ns.metadata.labels ?? {};
  const a = ns.metadata.annotations ?? {};
  const id = l[LABEL_STORE_ID];
  if (l[LABEL_STORE] !== "true" || !id) return undefined;
  const stored = a[ANN_PHASE];
  const phase: Phase = ns.metadata.deletionTimestamp ? "Deleting" : stored === "Ready" || stored === "Failed" || stored === "Deleting" ? stored : "Provisioning";
  return {
    id,
    name: a[ANN_NAME] ?? id,
    namespace: ns.metadata.name,
    phase,
    reason: a[ANN_REASON] || null,
    url: `${scheme}://${id}.${baseDomain}`,
    ownerId: l[LABEL_OWNER] ?? "",
    ownerEmail: a[ANN_OWNER_EMAIL] ?? null,
    createdAt: a[ANN_CREATED] ?? new Date(0).toISOString(),
  };
};
