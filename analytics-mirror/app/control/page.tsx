// @purpose Server wrapper for the control page — renders the shared I1 conflict banner
// (server component, Neon query) above the client-side control UI, which keeps its own
// hub polling and setpoint POSTs unchanged in ./control-client.tsx.
import { I1Banner } from "../i1-banner";
import ControlClient from "./control-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function ControlPage() {
  return (
    <>
      <I1Banner />
      <ControlClient />
    </>
  );
}
