/**
 * Snapshot storage — the saved images of a project's amps.
 *
 * Files live next to projects and the speaker library, under
 * `<APP_USER_DATA>/storage/snapshots/<projectId>/<id>.json`, so the whole app
 * state sits in one place a user can back up or copy to another machine.
 *
 *   GET    /api/snapshots?projectId=…   list snapshots (metadata only)
 *   GET    /api/snapshots?id=…&projectId=…  read one snapshot in full
 *   POST   /api/snapshots               save a snapshot
 *   DELETE /api/snapshots?id=…&projectId=…  delete one
 */

import fs from "fs/promises";
import path from "path";
import type { ProjectSnapshot } from "@/lib/types/amp-snapshot";

export const dynamic = "force-dynamic";

function getSnapshotsDir(projectId: string): string {
  const base = process.env.APP_USER_DATA ?? process.cwd();
  return path.join(base, "storage", "snapshots", sanitizeId(projectId));
}

/** Ids reach the filesystem, so reject anything that could escape the folder. */
function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Metadata shown in the list, without the (large) payload. */
function toSummary(snapshot: ProjectSnapshot, byteLength: number) {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    note: snapshot.note,
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    ampCount: snapshot.amps?.length ?? 0,
    fullyVerified: snapshot.fullyVerified,
    byteLength
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const id = url.searchParams.get("id");

  if (!projectId) {
    return Response.json({ error: "Missing projectId" }, { status: 400 });
  }

  const dir = getSnapshotsDir(projectId);

  if (id) {
    try {
      const raw = await fs.readFile(path.join(dir, `${sanitizeId(id)}.json`), "utf8");
      return Response.json({ success: true, snapshot: JSON.parse(raw) as ProjectSnapshot });
    } catch (err) {
      return Response.json(
        { error: `Snapshot not readable: ${err instanceof Error ? err.message : String(err)}` },
        { status: 404 }
      );
    }
  }

  try {
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const snapshots = [];
    for (const file of files) {
      try {
        const full = path.join(dir, file);
        const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
        snapshots.push(toSummary(JSON.parse(raw) as ProjectSnapshot, stat.size));
      } catch {
        // One unreadable file must not hide every other snapshot.
      }
    }
    snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({ success: true, snapshots });
  } catch (err) {
    return Response.json(
      { error: `Could not list snapshots: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let snapshot: ProjectSnapshot;
  try {
    snapshot = (await request.json()) as ProjectSnapshot;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!snapshot?.projectId || !snapshot?.id) {
    return Response.json({ error: "Snapshot needs projectId and id" }, { status: 400 });
  }

  try {
    const dir = getSnapshotsDir(snapshot.projectId);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${sanitizeId(snapshot.id)}.json`);
    // Write to a temp file and rename, so an interrupted write cannot leave a
    // half-written snapshot that looks valid in the list.
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmp, target);
    const stat = await fs.stat(target);
    return Response.json({ success: true, snapshot: toSummary(snapshot, stat.size) });
  } catch (err) {
    return Response.json(
      { error: `Could not save snapshot: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const id = url.searchParams.get("id");

  if (!projectId || !id) {
    return Response.json({ error: "Missing projectId or id" }, { status: 400 });
  }

  try {
    await fs.unlink(path.join(getSnapshotsDir(projectId), `${sanitizeId(id)}.json`));
    return Response.json({ success: true });
  } catch (err) {
    return Response.json(
      { error: `Could not delete snapshot: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
