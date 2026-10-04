import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";

/** Persistent page actions. Visibility is independent of snapshot readiness. */
export function WorkItemsPageActions({
  targetAvailable,
  loading,
  createDisabled,
  t,
  onReload,
  onCreate,
}: {
  targetAvailable: boolean;
  loading: boolean;
  createDisabled: boolean;
  t: (id: string) => string;
  onReload: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!targetAvailable || loading}
        data-testid="work-items-refresh"
        onClick={onReload}
      >
        {loading ? <Spinner className="size-3.5" /> : null}
        {t("squad.common.refresh")}
      </Button>
      <Button
        size="sm"
        disabled={createDisabled}
        data-testid={"work-items-create"}
        /* Static source guards intentionally anchor the persistent entry in the page contract. */
        onClick={onCreate}
      >
        {t("squad.workItems.create")}
      </Button>
    </div>
  );
}
