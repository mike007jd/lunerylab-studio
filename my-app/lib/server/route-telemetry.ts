type TelemetryFields = Record<string, string | number | boolean | null | undefined>;

function getRequestId(request: Request): string | undefined {
  return (
    request.headers.get("x-vercel-id") ||
    request.headers.get("x-request-id") ||
    undefined
  );
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status)) return status;
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

export function createRouteTelemetry(route: string, request: Request) {
  const startedAt = Date.now();
  const requestId = getRequestId(request);

  function write(
    level: "info" | "error",
    event: "start" | "done" | "failed",
    fields: TelemetryFields = {},
  ) {
    const payload = {
      level,
      event,
      route,
      requestId,
      ms: Date.now() - startedAt,
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      console.error(line);
      return;
    }
    console.log(line);
  }

  return {
    start(fields?: TelemetryFields) {
      write("info", "start", fields);
    },
    done(status: number, fields?: TelemetryFields) {
      write("info", "done", { status, ...fields });
    },
    failed(error: unknown, fields?: TelemetryFields) {
      write("error", "failed", {
        status: getErrorStatus(error),
        code: getErrorCode(error),
        ...fields,
      });
    },
  };
}
