import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { AcceptInvite } from "./pages/AcceptInvite";
import { Audit } from "./pages/Audit";
import { Chat } from "./pages/Chat";
import { Connect } from "./pages/Connect";
import { Keys } from "./pages/Keys";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Servers } from "./pages/Servers";
import { Stores } from "./pages/Stores";
import { Team } from "./pages/Team";

export function App() {
  const { me, loading } = useAuth();
  return (
    <Routes>
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <Login />} />
      <Route element={loading ? <Spinner /> : me ? <Layout /> : <Navigate to="/login" replace />}>
        <Route index element={<Overview />} />
        <Route path="chat" element={<Chat />} />
        <Route path="stores" element={<Stores />} />
        <Route path="servers" element={<Servers />} />
        <Route path="keys" element={<Keys />} />
        <Route path="connect" element={<Connect />} />
        <Route path="audit" element={<Audit />} />
        <Route path="team" element={me?.user.role === "admin" ? <Team /> : <Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
