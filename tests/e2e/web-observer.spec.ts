import { expect, test } from "@playwright/test";
import { startTestSystem, type TestSystem } from "@session-bus/test-support";

let system: TestSystem;
let alice: Awaited<ReturnType<TestSystem["startMcpSession"]>>;
let bob: Awaited<ReturnType<TestSystem["startMcpSession"]>>;
let carol: Awaited<ReturnType<TestSystem["startMcpSession"]>>;

test.beforeAll(async () => {
  system = await startTestSystem({ port: 7345 });
  alice = await system.startMcpSession("codex-api", "codex");
  bob = await system.startMcpSession("claude-review", "claude-code");
  carol = await system.startMcpSession("opencode-tests", "opencode");
});

test.afterAll(async () => {
  await system?.close();
});

test("observes invitations, task completion, and room closure live", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("codex-api", { exact: true })).toBeVisible();
  await expect(page.getByText("claude-review", { exact: true })).toBeVisible();
  await expect(page.getByText("opencode-tests", { exact: true })).toBeVisible();

  const created = await alice.call("create_room", {
    title: "Authentication",
    objective: "Implement and verify auth",
    idempotencyKey: "browser-room-1",
  });
  const roomId = created.room.id as string;
  const roomButton = page.getByRole("button", { name: /Authentication/ });
  await expect(roomButton).toBeVisible({ timeout: 10_000 });
  await roomButton.click();

  await alice.call("invite_sessions", {
    roomId,
    sessionIds: [bob.sessionId, carol.sessionId],
    idempotencyKey: "browser-invite-1",
  });
  await expect(page.getByText("Invitation").first()).toBeVisible();
  await bob.call("respond_to_invitation", {
    roomId,
    accept: true,
    idempotencyKey: "browser-bob-accept",
  });
  await carol.call("respond_to_invitation", {
    roomId,
    accept: true,
    idempotencyKey: "browser-carol-accept",
  });

  const createdTask = await alice.call("create_task", {
    roomId,
    title: "Review schema",
    description: "Verify database changes",
    idempotencyKey: "browser-task-1",
  });
  await bob.call("claim_task", {
    taskId: createdTask.task.id,
    idempotencyKey: "browser-claim-1",
  });
  await bob.call("update_task", {
    taskId: createdTask.task.id,
    status: "completed",
    resultSummary: "Schema approved",
    idempotencyKey: "browser-complete-1",
  });
  await expect(page.getByText("Review schema", { exact: true })).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).last(),
  ).toBeVisible();

  await alice.call("close_room", {
    roomId,
    summary: "Implementation and review complete",
    idempotencyKey: "browser-close-1",
  });
  await expect(
    page.getByText("Implementation and review complete").first(),
  ).toBeVisible();
  await expect(page.getByText("closed", { exact: true }).first()).toBeVisible();
});
