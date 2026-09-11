import { HarnessError } from "../../core/src/contracts.ts";
import type { Ticket } from "../../core/src/contracts.ts";

export interface IntegrationConfig {
  id: string;
  kind: "jira" | "confluence" | "stash";
  baseUrl: string;
  tokenEnvironment: string;
}
export class InternalClient {
  config: IntegrationConfig;
  constructor(config: IntegrationConfig) {
    const u = new URL(config.baseUrl);
    if (u.protocol !== "https:")
      throw new HarnessError("POLICY", "Internal API endpoints must use HTTPS");
    this.config = config;
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new HarnessError("POLICY", "Invalid internal API path");
    const token = process.env[this.config.tokenEnvironment];
    if (!token)
      throw new HarnessError(
        "INFRASTRUCTURE",
        `Missing credential environment: ${this.config.tokenEnvironment}`,
      );
    const url = this.config.baseUrl.replace(/\/$/, "") + path;
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new HarnessError(
        "INFRASTRUCTURE",
        `${this.config.kind} returned HTTP ${response.status}`,
      );
    const reader = response.body?.getReader();
    let text = "";
    let bytes = 0;
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new HarnessError("INPUT", "Internal response exceeds 2 MB");
        }
        text += new TextDecoder().decode(chunk.value);
      }
    return text ? JSON.parse(text) : {};
  }
  async ticket(key: string): Promise<Ticket> {
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key))
      throw new HarnessError("INPUT", "Invalid Jira key");
    const issue = await this.request(
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype`,
    );
    return {
      key,
      title: issue.fields.summary,
      description:
        typeof issue.fields.description === "string"
          ? issue.fields.description
          : JSON.stringify(issue.fields.description),
      acceptanceCriteria: [],
      issueType: issue.fields.issuetype?.name,
      isEpic:
        issue.fields.issuetype?.hierarchyLevel === 1 ||
        issue.fields.issuetype?.name?.toLowerCase() === "epic",
    };
  }
  async comments(key: string) {
    return this.request(
      `/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=100`,
    );
  }
  async page(id: string) {
    if (!/^\d+$/.test(id)) throw new HarnessError("INPUT", "Invalid page ID");
    return this.request(`/rest/api/content/${id}?expand=body.storage,version`);
  }
  async findPR(project: string, slug: string, branch: string, marker: string) {
    let start = 0;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(
        `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}/pull-requests?state=ALL&limit=100&start=${start}`,
      );
      const matches = result.values.filter(
        (pr: any) =>
          pr.description?.includes(marker) &&
          pr.fromRef?.id === `refs/heads/${branch}`,
      );
      if (matches.length > 1)
        throw new HarnessError(
          "INFRASTRUCTURE",
          "Multiple PRs match publication identity",
        );
      if (matches[0]) return matches[0];
      if (result.isLastPage) return null;
      if (
        !Number.isInteger(result.nextPageStart) ||
        result.nextPageStart <= start
      )
        throw new HarnessError("INFRASTRUCTURE", "Invalid Stash pagination");
      start = result.nextPageStart;
    }
    throw new HarnessError(
      "INFRASTRUCTURE",
      "PR reconciliation exceeded pagination limit",
    );
  }
}
