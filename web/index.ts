import type { FrontendPlugin } from "@trame/web-api";
import { SqlSourceDatabaseActions, SqlSourceDatabaseEmpty } from "./Actions.tsx";
import { SqlSourceSettings } from "./Settings.tsx";

export default {
  id: "sql-source",
  Settings: SqlSourceSettings,
  DatabaseActions: SqlSourceDatabaseActions,
  DatabaseEmpty: SqlSourceDatabaseEmpty,
} satisfies FrontendPlugin;
