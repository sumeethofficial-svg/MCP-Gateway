import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { ApiError, get, post } from "./api";
import type { User } from "./types";

interface Me { user: User; gateway: { mcpUrl: string; lazyMcpUrl: string } }
interface AuthState { me: Me | null; loading: boolean; logout: () => Promise<void> }
const Ctx = createContext<AuthState>({ me: null, loading: true, logout: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await get<Me>("/api/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
  const logout = async () => {
    await post("/api/auth/logout");
    qc.clear();
    qc.setQueryData(["me"], null);
  };
  return <Ctx.Provider value={{ me: q.data ?? null, loading: q.isLoading, logout }}>{children}</Ctx.Provider>;
}
