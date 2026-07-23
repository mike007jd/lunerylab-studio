import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchBootstrapData } from "@/lib/server/queries";
import { SettingsPage } from "@/components/settings/settings-page";

export const dynamic = "force-dynamic";

export default async function SettingsRoute() {
  await ensureLocalWorkspaceOwner();
  const { app, providers, providerConnections } = await fetchBootstrapData(
    LOCAL_WORKSPACE_OWNER.id,
  );

  return (
    <SettingsPage
      initialData={{
        user: {
          id: LOCAL_WORKSPACE_OWNER.id,
          email: LOCAL_WORKSPACE_OWNER.email,
          name: LOCAL_WORKSPACE_OWNER.name,
          avatarUrl: LOCAL_WORKSPACE_OWNER.avatarUrl,
        },
        app,
        providers,
        providerConnections,
      }}
    />
  );
}
