import type { FrontendPlugin } from "@trame/web-api";
import { DeploymentsCardPath } from "./CardPath.tsx";
import { DeploymentsPanel } from "./Panel.tsx";
import { DeploymentsSettings } from "./Settings.tsx";

export default {
  id: "deployments",
  Panel: DeploymentsPanel,
  column: true,
  Settings: DeploymentsSettings,
  CardFields: DeploymentsCardPath,
} satisfies FrontendPlugin;
