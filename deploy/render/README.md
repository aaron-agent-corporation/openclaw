# Render deployment

The `Render image` workflow builds this fork's complete upstream `Dockerfile`,
tests the retained Workboard, OpenAI, Codex, and auth customizations, and smoke
tests the resulting Linux AMD64 image. It publishes that same image to
`public.ecr.aws/p9u4c4e7/openclaw-gateway`. The existing Render service and
Cloudflare routing stay in place.

`required-plugins.mjs` is the shared image selection and smoke-test inventory.
It includes every configured production plugin, including externally distributed
plugins that upstream's default Docker build omits. The image smoke imports each
packaged entrypoint and verifies its manifest ID before starting the gateway.

Repository settings:

| Setting                         | Value                                                       |
| ------------------------------- | ----------------------------------------------------------- |
| Variable `AWS_ROLE_ARN`         | `arn:aws:iam::483461801575:role/OpenClawRenderGitHubDeploy` |
| Variable `ECR_IMAGE_REPOSITORY` | `public.ecr.aws/p9u4c4e7/openclaw-gateway`                  |
| Variable `RENDER_SERVICE_ID`    | `srv-dacu5ru1egvs7390isd0`                                  |
| Variable `RENDER_AUTO_DEPLOY`   | `false` initially                                           |

Create the GitHub Environment `render-production` with a custom deployment
branch policy allowing the `main` branch only (no tag rules). Store the
operator-authorized `RENDER_API_KEY` as a secret in that environment, **not as a
repository secret**. Remove any repository-level copy so off-main workflows
cannot access it.

AWS uses GitHub OIDC with audience `sts.amazonaws.com` and subject
`repo:aaron-agent-corporation/openclaw:ref:refs/heads/main`. The publish job has no
GitHub Environment, which would change that subject. Source tests run in a
separate job without OIDC or production secrets. A fresh runner loads the
tested image artifact and publishes it without executing candidate code.
The third job deploys the published digest through `render-production`; it has
no OIDC permission and receives the environment's Render secret only after the
environment's main-branch policy permits the job.
Actions, Node, Corepack, and the source's pnpm version are pinned.

Run the workflow **from `main`**. An empty `source_ref` selects main's commit at
dispatch; another branch, tag, or commit supports a build-only rehearsal. The
source resolves to a full commit SHA before checkout. Leave `deploy` unchecked
to test, build, smoke, and publish without changing Render. Pushes to main also
publish; they deploy only when `RENDER_AUTO_DEPLOY` is `true`.

Before an upgrade deployment:

1. On the running service, use its active state/config paths to run
   `openclaw backup create --verify --output <backup-directory>`. Preserve the
   verified archive outside the container, together with the current image
   digest and deployment ID. See [native backup documentation](https://docs.openclaw.ai/cli/backup).
2. Review the release's config and database migrations, confirm the verified
   backup covers the service's agent/workspace state, and pause new work if
   needed for a consistent operator handoff.
3. Dispatch `Render image` from main with `deploy` checked. Only a source that
   still matches current main can deploy. Keep automatic deployment disabled
   until the operator has accepted a backup policy for future updates.
4. Read the run summary for the exact source SHA, tested image digest, previous
   image, and Render deployment ID. Verify the real service over its existing
   operator access: internal gateway `/readyz`, Control UI assets, agent reply,
   and retained Workboard/auth behavior.

The disposable image smoke checks the actual OpenClaw CLI version, build commit,
managed Codex CLI against its installed package version, non-root user, gateway
`/readyz`, and every emitted Control UI JavaScript/CSS asset against the image's
build-owned size and SHA256 manifest (including tiny entry modules).
Render's `live` state plus matching image digest proves the image rollout. The
public wrapper `/healthz` only checks its socket/tunnel startup and cannot prove
the real gateway or an agent is working. The workflow does not claim that proof.

Each image has a `sha-<commit>` tag and a unique
`run-<run-id>-<attempt>` tag. Deployments use `repository@sha256:...` after the
registry digest matches the pushed image. Keep prior images available for
Render restarts and any operator-approved rollback; do not delete them as part
of routine cleanup. The temporary Actions image artifact expires after one day.

The helper records the previous configured and live image metadata, patches the
service's persistent image, then requests a deployment of that verified setting and polls for up to
20 minutes. Concurrent runs are serialized; a separate active Render deployment
blocks a new one. Network failures during writes have unknown outcomes: inspect
Render before rerunning. A timeout may still complete later. Failure never
automatically rolls back an image or database. If main advances after the image
setting was patched, inspect that staged setting before the next deployment.

API contracts: [update service](https://api-docs.render.com/reference/update-service),
[create deploy](https://api-docs.render.com/reference/create-deploy),
[retrieve deploy](https://api-docs.render.com/reference/retrieve-deploy), and
[image deployment requirements](https://render.com/docs/deploying-an-image).
PATCH does not trigger deployment; the helper preserves the service owner and
registry credential when changing its image. The deploy request omits the optional
`imageUrl` override: its separate lookup rejected a valid ECR digest in live use,
while requesting the same digest from the persistent setting was accepted.

Local helper checks: `node --test deploy/render/deploy.test.mjs`. A real image
smoke needs Docker and a fully built image:
`SOURCE_SHA=<sha> IMAGE_VERSION=<version> node deploy/render/smoke-image.mjs <image>`.
