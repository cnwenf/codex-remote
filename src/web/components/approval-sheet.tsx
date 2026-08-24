import { useEffect, useRef, useState } from "react";
import type { RpcRequest } from "../../protocol/types";

export type ApprovalDecision = "accept" | "decline";
export type ApprovalResolution = {
  decision: ApprovalDecision;
  result: unknown;
};

export function ApprovalSheet({
  request,
  onResolve,
}: {
  request: RpcRequest;
  onResolve: (resolution: ApprovalResolution) => void;
}) {
  const denyRef = useRef<HTMLButtonElement>(null);
  const [resolved, setResolved] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const summary = summarizeRequest(request);
  const params = asRecord(request.params);
  const questions = parseQuestions(params.questions);
  const isUserInput = request.method.includes("requestUserInput");

  useEffect(() => denyRef.current?.focus(), []);

  function resolve(decision: ApprovalDecision) {
    if (resolved) return;
    setResolved(true);
    onResolve({ decision, result: responseForRequest(request, decision, answers) });
  }

  return (
    <aside className="approval-sheet" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="sheet-handle" aria-hidden="true" />
      <p className="eyebrow">Action required</p>
      <h2 id="approval-title">{summary.title}</h2>
      <p className="approval-copy">Review exactly what Codex is requesting on this Mac.</p>
      {isUserInput ? (
        <div className="approval-questions">
          {questions.map((question) => (
            <fieldset key={question.id}>
              <legend>{question.question}</legend>
              {question.options.length > 0 ? question.options.map((option) => (
                <label key={option.label}>
                  <input
                    type="radio"
                    name={`approval-${question.id}`}
                    value={option.label}
                    checked={answers[question.id] === option.label}
                    onChange={() => setAnswers((current) => ({
                      ...current,
                      [question.id]: option.label,
                    }))}
                  />
                  <span><strong>{option.label}</strong>{option.description ? ` — ${option.description}` : ""}</span>
                </label>
              )) : (
                <label>
                  <span>{question.header}</span>
                  <input
                    type={question.isSecret ? "password" : "text"}
                    value={answers[question.id] ?? ""}
                    onChange={(event) => setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))}
                  />
                </label>
              )}
            </fieldset>
          ))}
        </div>
      ) : (
        <dl className="approval-details">
          {summary.details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="approval-actions">
        <button
          ref={denyRef}
          className="deny-button"
          type="button"
          disabled={resolved}
          onClick={() => resolve("decline")}
        >
          Deny
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={resolved}
          onClick={() => resolve("accept")}
        >
          {isUserInput ? "Submit answer" : "Approve once"}
        </button>
      </div>
    </aside>
  );
}

function responseForRequest(
  request: RpcRequest,
  decision: ApprovalDecision,
  answers: Record<string, string>,
) {
  const params = asRecord(request.params);
  if (request.method.includes("requestUserInput")) {
    const result: Record<string, { answers: string[] }> = {};
    for (const question of parseQuestions(params.questions)) {
      const answer = answers[question.id]?.trim();
      result[question.id] = { answers: decision === "accept" && answer ? [answer] : [] };
    }
    return { answers: result };
  }
  if (request.method.includes("permissions")) {
    return {
      permissions: decision === "accept" ? asRecord(params.permissions) : {},
      scope: "turn",
    };
  }
  return { decision };
}

function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const question = asRecord(entry);
    const id = text(question.id);
    const prompt = text(question.question);
    if (!id || !prompt) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((entry) => {
          const option = asRecord(entry);
          const label = text(option.label);
          return label ? [{ label, description: text(option.description) }] : [];
        })
      : [];
    return [{
      id,
      question: prompt,
      header: text(question.header) || "Answer",
      isSecret: question.isSecret === true,
      options,
    }];
  });
}

function summarizeRequest(request: RpcRequest) {
  const params = asRecord(request.params);
  if (request.method.includes("commandExecution")) {
    const command = Array.isArray(params.command)
      ? params.command.filter((value): value is string => typeof value === "string").join(" ")
      : text(params.command);
    return {
      title: "Run a command?",
      details: [
        ["Command", truncate(command || "Command details unavailable")],
        ["Folder", truncate(text(params.cwd) || "Current workspace")],
      ] as Array<[string, string]>,
    };
  }
  if (request.method.includes("fileChange")) {
    return {
      title: "Apply file changes?",
      details: [["Change", truncate(text(params.reason) || "Modify workspace files")]] as Array<[
        string,
        string,
      ]>,
    };
  }
  if (request.method.includes("requestUserInput")) {
    return {
      title: "Codex needs input",
      details: [["Question", truncate(text(params.question) || "Open the request to continue")]] as Array<[
        string,
        string,
      ]>,
    };
  }
  return {
    title: "Grant permission?",
    details: [["Request", request.method]] as Array<[string, string]>,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function truncate(value: string) {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
}
