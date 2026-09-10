import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repository = "aaron-agent-corporation/openclaw";
const imageRepository = "public.ecr.aws/p9u4c4e7/openclaw-gateway";
const active = new Set([
  "created",
  "queued",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress",
]);

// Render PATCH stages the persistent image but does not deploy it. Keep writes
// separate, single-attempt operations: a lost response can still mean success.
export async function deployRender({
  env = process.env,
  fetchImpl = fetch,
  sleep = setTimeout,
  now = Date.now,
  report = console.log,
  timeoutMs = 20 * 60_000,
} = {}) {
  const { SOURCE_SHA: source, IMAGE_URL: image, RENDER_SERVICE_ID: serviceId } = env;
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Deploy workflow must run from the fork's main branch");
  }
  if (
    !/^[a-f0-9]{40}$/.test(source ?? "") ||
    !image?.startsWith(`${imageRepository}@sha256:`) ||
    !/^sha256:[a-f0-9]{64}$/.test(image.slice(imageRepository.length + 1))
  ) {
    throw new Error("Deploy requires an immutable source SHA and expected ECR image digest");
  }
  if (serviceId !== "srv-dacu5ru1egvs7390isd0" || !env.RENDER_API_KEY || !env.GH_TOKEN) {
    throw new Error("Set RENDER_SERVICE_ID, RENDER_API_KEY, and GH_TOKEN before deploying");
  }
  const digest = image.slice(imageRepository.length + 1);
  async function request(url, token, method = "GET", body) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(
        `${method} request failed. ${method === "GET" ? "Inspect the run and Render status." : "Write outcome is unknown; inspect Render before retrying."}`,
      );
    }
    if (!response.ok)
      throw new Error(
        `${method} request returned HTTP ${response.status}; inspect Render before retrying. No rollback was attempted.`,
      );
    return response.json();
  }
  const serviceUrl = `https://api.render.com/v1/services/${serviceId}`;
  const render = (suffix = "", method, body) =>
    request(`${serviceUrl}${suffix}`, env.RENDER_API_KEY, method, body);
  async function requireCurrentMain() {
    const main = await request(
      `https://api.github.com/repos/${repository}/commits/main`,
      env.GH_TOKEN,
    );
    if (main.sha !== source)
      throw new Error("Source is no longer current main; deploy the newer main build instead");
  }
  await requireCurrentMain();
  const service = await render();
  if (
    !service.ownerId ||
    (!service.imagePath?.startsWith(`${imageRepository}:`) &&
      !service.imagePath?.startsWith(`${imageRepository}@`))
  ) {
    throw new Error("Render service owner or configured image repository does not match");
  }
  if (service.suspended !== "not_suspended")
    throw new Error("Render service is suspended; inspect it before deploying");
  const deployments = await render("/deploys?limit=20");
  const entries = deployments.map((entry) => entry.deploy);
  if (entries.some((entry) => active.has(entry.status)))
    throw new Error("Render already has an active deployment; wait for it before retrying");
  const previousLive = entries.find((entry) => entry.status === "live");
  // Save only image metadata, never the service response (which can contain
  // sensitive settings). This survives a PATCH/POST failure in the run summary.
  report(`Previous configured image: ${service.imagePath}`);
  report(
    `Previous live deployment: ${previousLive?.id ?? "unknown"}; image: ${previousLive?.image?.ref ?? "unknown"}; digest: ${previousLive?.image?.sha ?? "unknown"}`,
  );
  report(`Requested source: ${source}; image: ${image}`);
  if (service.imagePath === image && previousLive?.image?.sha === digest) {
    report(`Already live at the requested digest: ${previousLive.id}`);
    return previousLive;
  }
  await requireCurrentMain();
  await render("", "PATCH", {
    image: {
      imagePath: image,
      ownerId: service.ownerId,
      ...(service.registryCredential?.id
        ? { registryCredentialId: service.registryCredential.id }
        : {}),
    },
  });
  const staged = await render();
  if (staged.imagePath !== image)
    throw new Error(
      "Render did not retain the requested image; inspect service settings before retrying",
    );
  await requireCurrentMain();
  const deployment = await render("/deploys", "POST", {
    imageUrl: image,
    clearCache: "do_not_clear",
  });
  if (!deployment.id)
    throw new Error("Render returned no deployment ID; inspect Render before retrying");
  report(`Render deployment: ${deployment.id}`);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const current = await render(`/deploys/${encodeURIComponent(deployment.id)}`);
    if (current.status === "live") {
      if (current.image?.sha !== digest)
        throw new Error(
          "Live deployment digest does not match the tested image; inspect Render. No rollback was attempted.",
        );
      const finalService = await render();
      if (finalService.imagePath !== image)
        throw new Error("Render image settings changed during deployment; inspect Render");
      report(
        `Render reports live: ${current.id}; digest: ${digest}. Verify the real gateway and agent flow on the persistent service.`,
      );
      return current;
    }
    if (!active.has(current.status))
      throw new Error(
        `Render deployment ${deployment.id} ended as ${current.status}; inspect logs and saved previous image. No rollback was attempted.`,
      );
    await sleep(15_000);
  }
  throw new Error(
    `Timed out waiting for Render deployment ${deployment.id}; it may still finish. Inspect Render before retrying. No rollback was attempted.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = (message) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
  };
  try {
    await deployRender({ report });
  } catch (error) {
    report(`Deployment stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
