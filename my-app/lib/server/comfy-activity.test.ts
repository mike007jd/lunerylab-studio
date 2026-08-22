import { beforeEach, describe, expect, it } from "vitest";
import {
  listRecentComfyJobs,
  recordComfyJobFinished,
  recordComfyJobStarted,
  resetComfyActivityForTests,
} from "@/lib/server/comfy-activity";

beforeEach(() => {
  resetComfyActivityForTests();
});

function start(id: string, endpoint = "http://192.168.1.143:8188") {
  recordComfyJobStarted({
    id,
    endpoint,
    workflow: { "3": { class_type: "KSampler" } },
    prompt: "p",
  });
}

describe("comfy-activity feed", () => {
  it("records a started job as running, newest first", () => {
    start("a");
    start("b");
    const jobs = listRecentComfyJobs();
    expect(jobs.map((job) => job.id)).toEqual(["b", "a"]);
    expect(jobs[0]?.status).toBe("running");
    expect(jobs[0]?.workflow).toEqual({ "3": { class_type: "KSampler" } });
  });

  it("marks a running job finished exactly once", () => {
    start("a");
    recordComfyJobFinished("http://192.168.1.143:8188", "a", "completed");
    recordComfyJobFinished("http://192.168.1.143:8188", "a", "failed");
    const [job] = listRecentComfyJobs();
    expect(job?.status).toBe("completed");
    expect(job?.finishedAt).toBeTruthy();
  });

  it("scopes finish records to the endpoint", () => {
    start("a", "http://one:8188");
    recordComfyJobFinished("http://two:8188", "a", "failed");
    expect(listRecentComfyJobs()[0]?.status).toBe("running");
  });

  it("re-queueing the same prompt id replaces the stale entry", () => {
    start("a");
    recordComfyJobFinished("http://192.168.1.143:8188", "a", "failed");
    start("a");
    const jobs = listRecentComfyJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("running");
  });

  it("rejects malformed records and caps the ring", () => {
    recordComfyJobStarted({ id: "", endpoint: "http://x:1", workflow: null, prompt: "" });
    for (let i = 0; i < 60; i += 1) start(`job-${i}`);
    const jobs = listRecentComfyJobs();
    expect(jobs).toHaveLength(50);
    expect(jobs[0]?.id).toBe("job-59");
    expect(jobs[49]?.id).toBe("job-10");
  });
});
