import type { SquadSurfaceViewState } from "./squadSurfaceViewModel.js";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";

/**
 * Work-items page status projection.
 *
 * The page owns fetching and the state machine input; this component only
 * projects the shared state-machine result into the existing four UI states
 * and refresh affordances. Keeping that boundary here avoids a second state
 * owner or a second failure/loading decision.
 */
export function WorkItemsPageStatus({
  state,
  t,
  onReload,
}: {
  state: SquadSurfaceViewState;
  t: (id: string) => string;
  onReload: () => void;
}) {
  return (
    <>
      {state.mode === "ready" && state.experimentDisabled ? (
        <Alert variant="warning" data-testid="work-items-experiment-off">
          <AlertTitle>{t("squad.common.experimentOff")}</AlertTitle>
        </Alert>
      ) : null}

      {state.mode === "ready" && state.loadFailure ? (
        <Alert variant="destructive" data-testid="work-items-load-failure">
          <AlertTitle>{t("squad.workItems.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(state.loadFailure.messageId)}
            {state.loadFailure.detail ? `：${state.loadFailure.detail}` : ""}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={onReload}>
              {t("squad.common.refresh")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {state.mode === "no-workspace" ? (
        <Alert data-testid="work-items-no-workspace">
          <AlertTitle>{t("squad.common.noWorkspace")}</AlertTitle>
        </Alert>
      ) : null}

      {state.mode === "loading" ? (
        <div
          className="flex items-center gap-2 text-ui-base text-foreground-subtle"
          data-testid="work-items-loading"
        >
          <Spinner className="size-3.5" />
          {t("squad.workItems.loading")}
        </div>
      ) : null}

      {state.mode === "error" ? (
        <Alert variant="destructive" data-testid="work-items-error">
          <AlertTitle>{t("squad.workItems.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(state.feedback.messageId)}
            {state.feedback.detail ? `：${state.feedback.detail}` : ""}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={onReload}>
              {t("squad.common.refresh")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </>
  );
}
