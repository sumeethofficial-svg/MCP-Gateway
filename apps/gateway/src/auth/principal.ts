export type Role = "admin" | "member";

/** How the caller reached the gateway. Recorded in the audit log. */
export type Via = "api_key" | "chat";

/** The authenticated identity behind a request. Every tool call is attributed to one. */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  via: Via;
  /** Non-secret prefix of the API key used, if any. */
  keyPrefix?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabledAt: Date | null;
  createdAt: Date;
}
