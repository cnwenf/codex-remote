import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QuestionContext, QuestionContextRequest } from "../../protocol/question-context";

export type QuestionAnchor = { turnId: string; anchorItemId?: string };
export type ReadQuestionContext = (request: QuestionContextRequest, signal?: AbortSignal) => Promise<QuestionContext>;

type Options = {
  threadId: string;
  anchor?: QuestionAnchor;
  connection: "disconnected" | "connecting" | "reconnecting" | "ready";
  readQuestionContext: ReadQuestionContext;
};

type QuerySnapshot = {
  key: string;
  context: QuestionContext;
};

type ConfirmedPages = {
  context: QuestionContext;
  pages: string[];
  nextTextOffset?: number;
};

type Continuation = {
  controller: AbortController;
  key: string;
  questionIdentity: string;
  textOffset: number;
};

type PageStatus = {
  key: string;
  questionIdentity: string;
  loading: boolean;
  error?: string;
};

const RETRY_DELAYS_MS = [200, 500, 1_000, 2_000];
const MAX_RETRY_DELAY_MS = 5_000;
const TURN_CONTEXT_REVALIDATE_MS = 2_000;
const FAILURE_REVALIDATE_MS = 5_000;
const SUCCESS_REVALIDATE_MS = 30_000;
const CACHE_LIMIT = 24;

export function useQuestionContext({ threadId, anchor, connection, readQuestionContext }: Options) {
  const key = connection === "ready" && anchor ? requestKey(threadId, anchor) : undefined;
  const keyRef = useRef(key);
  keyRef.current = key;
  const cache = useRef(new Map<string, QuestionContext>());
  const continuation = useRef<Continuation | undefined>(undefined);
  const [query, setQuery] = useState<QuerySnapshot>();
  const [confirmedPages, setConfirmedPages] = useState<ConfirmedPages>();
  const [pageStatus, setPageStatus] = useState<PageStatus>();
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (connection === "ready") return;
    cache.current.clear();
    setQuery(undefined);
  }, [connection]);

  useEffect(() => () => {
    continuation.current?.controller.abort();
    continuation.current = undefined;
  }, []);

  useEffect(() => {
    const active = continuation.current;
    if (active && active.key !== key) {
      active.controller.abort();
      if (continuation.current === active) continuation.current = undefined;
    }
    setPageStatus((value) => value?.key === key ? value : undefined);
  }, [key]);

  useEffect(() => {
    if (!key || !anchor) return;
    const cached = cache.current.get(key);
    if (cached) {
      setQuery({ key, context: cached });
      setConfirmedPages((value) => mergeConfirmedPages(value, cached));
    } else setQuery((value) => value?.key === key ? value : undefined);
    const controller = new AbortController();
    const request: QuestionContextRequest = { threadId, ...anchor };
    const read = async () => {
      try {
        while (!controller.signal.aborted && keyRef.current === key) {
          let context: QuestionContext;
          try {
            context = await pollQuestion(readQuestionContext, request, controller.signal, (pending) => {
              if (keyRef.current !== key) return;
              setQuery((value) => value?.key === key && value.context.state === "ready"
                ? value
                : { key, context: pending });
            });
          } catch (cause) {
            if (controller.signal.aborted || keyRef.current !== key) return;
            cache.current.delete(key);
            setQuery({ key, context: {
              ...request,
              state: "error",
              revision: "client-error",
              message: cause instanceof Error ? cause.message : "原始问题定位失败",
            } });
            if (!await waitForRetry(FAILURE_REVALIDATE_MS, controller.signal)) return;
            continue;
          }
          if (controller.signal.aborted || keyRef.current !== key) return;
          setQuery({ key, context });
          if (context.state === "ready") {
            remember(cache.current, key, context);
            setConfirmedPages((value) => mergeConfirmedPages(value, context));
          } else cache.current.delete(key);
          const delay = !anchor.anchorItemId
            ? TURN_CONTEXT_REVALIDATE_MS
            : context.state === "ready" ? SUCCESS_REVALIDATE_MS : FAILURE_REVALIDATE_MS;
          if (!await waitForRetry(delay, controller.signal)) return;
        }
      } catch (cause) {
        if (!controller.signal.aborted) throw cause;
      }
    };
    void read();
    return () => {
      controller.abort();
    };
  }, [anchor?.anchorItemId, anchor?.turnId, connection, key, readQuestionContext, refreshVersion, threadId]);

  const currentQuery = query?.key === key ? query : undefined;
  const currentQuestionIdentity = questionIdentity(currentQuery?.context);
  const confirmedQuestionIdentity = questionIdentity(confirmedPages?.context);
  const currentPages = currentQuestionIdentity && currentQuestionIdentity === confirmedQuestionIdentity
    ? confirmedPages
    : undefined;
  const currentPageStatus = currentPages && pageStatus && pageStatus.key === key &&
    pageStatus.questionIdentity === currentQuestionIdentity ? pageStatus : undefined;
  useEffect(() => {
    const active = continuation.current;
    if (active && confirmedQuestionIdentity && active.questionIdentity !== confirmedQuestionIdentity) {
      active.controller.abort();
      if (continuation.current === active) continuation.current = undefined;
    }
    setPageStatus((value) => !value || !confirmedQuestionIdentity ||
      value.questionIdentity === confirmedQuestionIdentity ? value : undefined);
  }, [confirmedQuestionIdentity]);

  const loadMore = useCallback(async () => {
    if (!anchor || !key || !currentPages?.context.question || currentPages.nextTextOffset === undefined ||
      currentPageStatus?.loading) return;
    const controller = new AbortController();
    continuation.current?.controller.abort();
    const expectedIdentity = questionIdentity(currentPages.context)!;
    const expectedTextOffset = currentPages.nextTextOffset;
    const active = { controller, key, questionIdentity: expectedIdentity, textOffset: expectedTextOffset };
    continuation.current = active;
    setPageStatus({ key, questionIdentity: expectedIdentity, loading: true });
    const expectedQuestionId = currentPages.context.question.id;
    try {
      const page = await pollQuestion(
        readQuestionContext,
        { threadId, ...anchor, textOffset: expectedTextOffset },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (page.state !== "ready" || page.question?.id !== expectedQuestionId) {
        if (continuation.current === active) setPageStatus({
          key, questionIdentity: expectedIdentity, loading: false,
          error: page.message || "原始问题后续内容加载失败",
        });
        return;
      }
      if (page.revision !== currentPages.context.revision) {
        cache.current.clear();
        setRefreshVersion((value) => value + 1);
        return;
      }
      setConfirmedPages((value) => value && questionIdentity(value.context) === expectedIdentity &&
        value.nextTextOffset === expectedTextOffset ? {
        ...value,
        pages: [...value.pages, page.question!.text],
        nextTextOffset: page.question!.nextTextOffset,
      } : value);
    } catch (cause) {
      if (!controller.signal.aborted && keyRef.current === key && continuation.current === active) {
        setPageStatus({
          key, questionIdentity: expectedIdentity, loading: false,
          error: cause instanceof Error ? cause.message : "原始问题后续内容加载失败",
        });
      }
    } finally {
      if (continuation.current === active) {
        continuation.current = undefined;
        setPageStatus((value) => value?.key === key && value.questionIdentity === expectedIdentity
          ? { ...value, loading: false }
          : value);
      }
    }
  }, [anchor?.anchorItemId, anchor?.turnId, currentPageStatus?.loading, currentPages, key,
    readQuestionContext, threadId]);

  return useMemo(() => ({
    context: currentQuery?.context,
    text: currentPages?.pages.join("") ?? "",
    nextTextOffset: currentPages?.nextTextOffset,
    loading: Boolean(key && !currentQuery),
    loadingMore: currentPageStatus?.loading ?? false,
    loadMoreError: currentPageStatus?.error,
    loadMore,
  }), [currentPageStatus, currentPages, currentQuery, key, loadMore]);
}

function requestKey(threadId: string, anchor: QuestionAnchor) {
  return `${threadId}\u0000${anchor.turnId}\u0000${anchor.anchorItemId ?? ""}`;
}

function fromContext(context: QuestionContext): ConfirmedPages {
  return {
    context,
    pages: context.question ? [context.question.text] : [],
    nextTextOffset: context.question?.nextTextOffset,
  };
}

function mergeConfirmedPages(current: ConfirmedPages | undefined, context: QuestionContext): ConfirmedPages {
  if (!current || questionIdentity(current.context) !== questionIdentity(context)) {
    return fromContext(context);
  }
  return {
    ...current,
    context,
    pages: [context.question?.text ?? "", ...current.pages.slice(1)],
    nextTextOffset: current.pages.length > 1 ? current.nextTextOffset : context.question?.nextTextOffset,
  };
}

function remember(cache: Map<string, QuestionContext>, key: string, context: QuestionContext) {
  cache.delete(key);
  cache.set(key, context);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

async function pollQuestion(
  readQuestionContext: ReadQuestionContext,
  request: QuestionContextRequest,
  signal: AbortSignal,
  onPending?: (context: QuestionContext) => void,
) {
  let retry = 0;
  while (!signal.aborted) {
    const context = await readQuestionContext(request, signal);
    if (!matchesRequest(context, request)) throw new Error("原始问题响应身份不匹配");
    if (context.state !== "pending") return context;
    onPending?.(context);
    const delay = RETRY_DELAYS_MS[retry] ?? MAX_RETRY_DELAY_MS;
    retry += 1;
    if (!await waitForRetry(delay, signal)) break;
  }
  throw new Error("codex-socket-request-aborted");
}

function matchesRequest(context: QuestionContext, request: QuestionContextRequest) {
  return context.threadId === request.threadId && context.turnId === request.turnId &&
    context.anchorItemId === request.anchorItemId &&
    (context.state !== "ready" || context.question?.textOffset === (request.textOffset ?? 0));
}

function questionIdentity(context?: QuestionContext) {
  const question = context?.state === "ready" ? context.question : undefined;
  return context && question ? [context.threadId, context.turnId, context.revision, question.id,
    question.source, question.sourceThreadId ?? ""].join("\u0000") : undefined;
}

function waitForRetry(delay: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(true); }, delay);
    const abort = () => { clearTimeout(timer); cleanup(); resolve(false); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
  });
}
