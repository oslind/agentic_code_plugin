import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { Mutex } from "../util/mutex";
import { ChatEntry, ChatMode, Conversation, ConversationSummary } from "./types";

/** Fewest conversations ever kept, whatever the setting says. */
export const MIN_KEPT = 3;
/** Entries kept per conversation. Older sub-agent chatter is dropped first. */
export const MAX_ENTRIES = 600;

/**
 * Saves chat conversations as JSON files and keeps only the most recent ones.
 * Layout: <root>/conversations/<id>.json. The runs a conversation started are
 * stored separately by TaskStore and are not removed with the conversation.
 */
export class ConversationStore {
  private readonly lock = new Mutex();

  constructor(
    private readonly root: string,
    private readonly keep: () => number = () => 10,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
    return path.join(this.root, "conversations", `${id}.json`);
  }

  async create(workspaceRoot: string, mode: ChatMode, title = "New task"): Promise<Conversation> {
    const time = this.now().toISOString();
    const conversation: Conversation = { id: randomUUID(), title, workspaceRoot, mode, createdAt: time, updatedAt: time, entries: [], runIds: [] };
    await this.lock.run(async () => {
      await this.write(conversation);
      await this.prune();
    });
    return conversation;
  }

  async load(id: string): Promise<Conversation> {
    return JSON.parse(await fs.readFile(this.file(id), "utf8")) as Conversation;
  }

  /** Most recently updated first. */
  async list(): Promise<ConversationSummary[]> {
    const all = await this.loadAll();
    return all.map(({ id, title, updatedAt, workspaceRoot }) => ({ id, title, updatedAt, workspaceRoot }));
  }

  /** Applies a change to a saved conversation. Changes are serialized, so parallel sub-agents can report at once. */
  update(id: string, change: (c: Conversation) => void): Promise<Conversation> {
    return this.lock.run(async () => {
      const c = await this.load(id);
      change(c);
      c.updatedAt = this.now().toISOString();
      if (c.entries.length > MAX_ENTRIES) c.entries = trimEntries(c.entries, MAX_ENTRIES);
      await this.write(c);
      return c;
    });
  }

  append(id: string, entry: Omit<ChatEntry, "id" | "time">): Promise<ChatEntry> {
    const full: ChatEntry = { id: randomUUID(), time: this.now().toISOString(), ...entry };
    return this.update(id, (c) => c.entries.push(full)).then(() => full);
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  private async loadAll(): Promise<Conversation[]> {
    const dir = path.join(this.root, "conversations");
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const all = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => this.load(n.slice(0, -5)).catch(() => undefined)),
    );
    return all.filter((c): c is Conversation => c !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Removes all but the most recent conversations. Never keeps fewer than MIN_KEPT. */
  private async prune(): Promise<void> {
    const keep = Math.max(MIN_KEPT, Math.floor(this.keep()) || MIN_KEPT);
    const all = await this.loadAll();
    for (const c of all.slice(keep)) await this.delete(c.id);
  }

  private async write(c: Conversation): Promise<void> {
    const file = this.file(c.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(c), "utf8");
    await fs.rename(tmp, file);
  }
}

/** Drops the oldest sub-agent entries first, so the user's and coordinator's messages survive longest. */
export function trimEntries(entries: ChatEntry[], max: number): ChatEntry[] {
  let excess = entries.length - max;
  if (excess <= 0) return entries;
  const out: ChatEntry[] = [];
  for (const e of entries) {
    if (excess > 0 && e.author === "agent") {
      excess--;
      continue;
    }
    out.push(e);
  }
  return excess > 0 ? out.slice(excess) : out;
}
