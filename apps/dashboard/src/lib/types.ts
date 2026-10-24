export type Role = "admin" | "member";
export interface User { id: string; email: string; name: string; role: Role }
export interface TeamUser extends User { disabled: boolean; createdAt: string; activeKeys: number }
export type ServerStatus = "connected" | "unreachable" | "disabled" | "unknown" | "pending";
export interface Server {
  id: string; slug: string; name: string; enabled: boolean; status: ServerStatus; toolCount: number | null;
  url?: string; authType?: "none" | "bearer" | "header"; authHeaderName?: string | null; hasCredential?: boolean;
  trustAnnotations?: boolean; managedBy?: "admin" | "helm" | "provisioner"; ownerId?: string | null; storeId?: string | null; statusReason?: string | null; lastCheckedAt?: string | null;
  latencyMs?: number | null; quarantinedTools?: number; createdAt?: string;
}
export interface PinInfo { status: "approved" | "quarantined" | "rejected"; flags?: { rule: string; excerpt?: string; severity?: string }[]; reason?: string | null; defHash?: string; previousDescription?: string | null }
export interface Decision { allowed: boolean; source: string; reason: string }
export interface ServerTool {
  name: string; exposedName: string; title: string | null; description: string; inputSchema: unknown;
  annotations?: { readOnlyHint: boolean | null; destructiveHint: boolean | null };
  pin: PinInfo; access?: { admin: Decision; member: Decision }; mine: Decision;
}
export interface ServerTools { server: { slug: string; name: string }; enabled: boolean; reachable: boolean; stale?: boolean; error?: string | null; tools: ServerTool[] }
export interface Rule { id: string; subjectType: "role" | "user"; subject: string; serverSlug: string; toolName: string; effect: "allow" | "deny"; createdAt: string; createdByEmail: string | null }
export interface ApiKey { id: string; userId: string; userEmail: string; name: string; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null }
export interface Invite { id: string; email: string; role: Role; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; createdAt: string; invitedByEmail: string | null }
export interface AuditRow {
  id: number; ts: string; userEmail: string | null; userId: string | null; via: "api_key" | "chat"; keyPrefix: string | null; clientName: string | null;
  serverSlug: string | null; toolName: string | null; exposedName: string | null; outcome: string; errorMessage: string | null; durationMs: number; argsPreview: string | null;
}
export interface Stats {
  windowHours: number; bucket: string; totals: { calls: number; failures: number; p50: number; p95: number }; activeUsers: number;
  perServer: { server: string; calls: number; failures: number; p95: number }[];
  series: { bucket: string; ok: number; failed: number }[]; topTools: { tool: string; calls: number }[];
}
export interface GatewayInfo { mcpUrl: string; lazyMcpUrl: string; toolCount: number; lazyThreshold: number; unreachable: { server: string; message: string }[]; tools: { name: string; description: string; readOnly: boolean }[] }
export type StorePhase = "Provisioning" | "Ready" | "Failed" | "Deleting";
export interface StoreRow {
  id: string; name: string; namespace: string; phase: StorePhase; reason: string | null; url: string;
  ownerId: string; ownerEmail: string | null; createdAt: string;
  owned: boolean; toolPrefix: string | null; registered: boolean; serverStatus: string | null; toolCount: number | null;
}
