import { apiErrorSchema } from "@session-bus/protocol";

export class HubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface HubClient {
  registerSession(profile: Record<string, unknown>): Promise<unknown>;
  request(
    path: string,
    init?: { method?: string; body?: unknown; idempotency?: string },
  ): Promise<unknown>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class HttpHubClient implements HubClient {
  constructor(
    private readonly baseUrl: string,
    private token?: string,
  ) {}

  async registerSession(profile: Record<string, unknown>): Promise<unknown> {
    const result = asObject(
      await this.call(
        "/api/v1/sessions",
        { method: "POST", body: profile },
        false,
      ),
    );
    if (!result || typeof result.instanceToken !== "string") {
      throw new Error(
        "Hub session registration did not return an instance token",
      );
    }
    this.token = result.instanceToken;
    return result.session;
  }

  request(
    path: string,
    init: { method?: string; body?: unknown; idempotency?: string } = {},
  ): Promise<unknown> {
    return this.call(path, init, true);
  }

  private async call(
    path: string,
    init: { method?: string; body?: unknown; idempotency?: string },
    auth: boolean,
  ): Promise<unknown> {
    const headers = new Headers({ Accept: "application/json" });
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (auth && this.token)
      headers.set("Authorization", `Bearer ${this.token}`);
    if (init.idempotency) headers.set("Idempotency-Key", init.idempotency);
    const response = await fetch(new URL(path, this.baseUrl), {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data);
      throw new HubError(
        parsed.success ? parsed.data.error.code : `HTTP_${response.status}`,
        parsed.success
          ? parsed.data.error.message
          : `Hub request failed (${response.status})`,
        response.status,
      );
    }
    return data;
  }
}
