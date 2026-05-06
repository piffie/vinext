import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import type { AppElements } from "./app-elements.js";
import {
  createPendingNavigationCommit,
  resolvePendingNavigationCommitDispositionDecision,
  routerReducer,
  type AppRouterAction,
  type AppRouterState,
  type OperationLane,
  type PendingNavigationCommit,
} from "./app-browser-state.js";
import {
  NavigationTraceReasonCodes,
  createNavigationTrace,
  type NavigationTrace,
} from "./navigation-trace.js";

type VisibleCommitDecision = {
  disposition: "commit";
  trace: NavigationTrace;
};
type HardNavigateCommitDecision = {
  disposition: "hard-navigate";
  trace: NavigationTrace;
};
type NoCommitDecision = {
  disposition: "no-commit";
  trace: NavigationTrace;
};
type CommitDecision = VisibleCommitDecision | HardNavigateCommitDecision | NoCommitDecision;
const approvedVisibleCommitBrand: unique symbol = Symbol("ApprovedVisibleCommit");
export type ApprovedVisibleCommit = {
  readonly [approvedVisibleCommitBrand]: true;
  readonly action: AppRouterAction;
  readonly decision: VisibleCommitDecision;
  readonly interceptionContext: string | null;
  readonly previousNextUrl: string | null;
  readonly rootLayoutTreePath: string | null;
  readonly routeId: string;
};
type VisibleCommitApproval = {
  approvedCommit: ApprovedVisibleCommit;
  decision: VisibleCommitDecision;
};
type NonVisibleCommitApproval = {
  approvedCommit: null;
  decision: HardNavigateCommitDecision | NoCommitDecision;
};
type CommitApproval = VisibleCommitApproval | NonVisibleCommitApproval;
type ClassifiedPendingNavigationCommit = {
  approvedCommit: ApprovedVisibleCommit | null;
  decision: CommitDecision;
  pending: PendingNavigationCommit;
  trace: NavigationTrace;
};

export function applyApprovedVisibleCommit(
  state: AppRouterState,
  commit: ApprovedVisibleCommit,
): AppRouterState {
  return routerReducer(state, commit.action);
}

function resolvePendingNavigationCommitDecision(options: {
  activeNavigationId: number;
  currentRootLayoutTreePath: string | null;
  nextRootLayoutTreePath: string | null;
  startedNavigationId: number;
}): CommitDecision {
  const { disposition, trace } = resolvePendingNavigationCommitDispositionDecision(options);

  switch (disposition) {
    case "skip":
      return { disposition: "no-commit", trace };
    case "hard-navigate":
      return { disposition: "hard-navigate", trace };
    case "dispatch":
      return createVisibleCommitDecision(trace);
    default: {
      const _exhaustive: never = disposition;
      throw new Error("[vinext] Unknown navigation commit disposition: " + String(_exhaustive));
    }
  }
}

function createVisibleCommitDecision(
  trace: NavigationTrace = createNavigationTrace(NavigationTraceReasonCodes.commitCurrent),
): VisibleCommitDecision {
  return { disposition: "commit", trace };
}

function createApprovedVisibleCommit(options: {
  decision: VisibleCommitDecision;
  pending: PendingNavigationCommit;
}): ApprovedVisibleCommit {
  return {
    [approvedVisibleCommitBrand]: true,
    action: options.pending.action,
    decision: options.decision,
    interceptionContext: options.pending.interceptionContext,
    previousNextUrl: options.pending.previousNextUrl,
    rootLayoutTreePath: options.pending.rootLayoutTreePath,
    routeId: options.pending.routeId,
  };
}

export function approveHmrVisibleCommit(pending: PendingNavigationCommit): ApprovedVisibleCommit {
  if (pending.action.operation.lane !== "hmr") {
    throw new Error("[vinext] HMR visible commit approval requires an HMR pending operation");
  }

  return createApprovedVisibleCommit({
    decision: createVisibleCommitDecision(),
    pending,
  });
}

export function approvePendingNavigationCommit(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  startedNavigationId: number;
}): CommitApproval {
  const decision = resolvePendingNavigationCommitDecision({
    activeNavigationId: options.activeNavigationId,
    currentRootLayoutTreePath: options.currentState.rootLayoutTreePath,
    nextRootLayoutTreePath: options.pending.rootLayoutTreePath,
    startedNavigationId: options.startedNavigationId,
  });

  switch (decision.disposition) {
    case "commit":
      return {
        approvedCommit: createApprovedVisibleCommit({
          decision,
          pending: options.pending,
        }),
        decision,
      };
    case "hard-navigate":
    case "no-commit":
      return {
        approvedCommit: null,
        decision,
      };
    default: {
      const _exhaustive: never = decision;
      throw new Error("[vinext] Unknown commit decision: " + String(_exhaustive));
    }
  }
}

export async function resolveAndClassifyNavigationCommit(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  nextElements: Promise<AppElements>;
  operationLane: OperationLane;
  previousNextUrl?: string | null;
  renderId: number;
  startedNavigationId: number;
  type: "navigate" | "replace" | "traverse";
}): Promise<ClassifiedPendingNavigationCommit> {
  const pending = await createPendingNavigationCommit({
    currentState: options.currentState,
    nextElements: options.nextElements,
    navigationSnapshot: options.navigationSnapshot,
    operationLane: options.operationLane,
    previousNextUrl: options.previousNextUrl,
    renderId: options.renderId,
    type: options.type,
  });

  const approval = approvePendingNavigationCommit({
    activeNavigationId: options.activeNavigationId,
    currentState: options.currentState,
    pending,
    startedNavigationId: options.startedNavigationId,
  });

  return {
    approvedCommit: approval.approvedCommit,
    decision: approval.decision,
    pending,
    trace: approval.decision.trace,
  };
}
