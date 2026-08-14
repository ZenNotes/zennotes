import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CloudAccount,
  CloudAccountConnectResult,
  CloudAccountStatus,
} from "@zennotes/bridge-contract/cloud-sync";
import type { CloudAuthDeepLinkRequest } from "./deep-links";

const PENDING_AUTH_FILE = "cloud-auth-pending.json";
const CLOUD_ACCOUNT_FILE = "cloud-account.json";
const AUTH_LIFETIME_MS = 5 * 60 * 1000;
const PRODUCTION_CLOUD_BASE_URL = "https://zennotes.org";
const DEVELOPMENT_CLOUD_BASE_URL = PRODUCTION_CLOUD_BASE_URL;
/** The Laravel Cloud origin 2.28.0 shipped with. The deployment moved to
 *  zennotes.org on release day and the old hostname stopped resolving, so a
 *  stored account pointing at it is migrated on first read: same service,
 *  same database, the token stays valid under the new origin. */
const LEGACY_CLOUD_BASE_URL = "https://zennotes.laravel.cloud";

interface PendingCloudAuth {
  base_url: string;
  state: string;
  code_verifier: string;
  expires_at: string;
}

interface CloudAuthExchangeResponse {
  token: string;
  user: CloudAccount["user"];
  device: CloudAccount["device"];
}

export interface CloudAuthManagerDependencies {
  storageDirectory: string;
  appVersion: string;
  deviceName: string;
  fetchImplementation?: typeof fetch;
  openExternal(url: string): Promise<unknown>;
  getSecret(baseUrl: string): Promise<string | null>;
  setSecret(baseUrl: string, token: string): Promise<boolean>;
  deleteSecret(baseUrl: string): Promise<void>;
  now?: () => Date;
  randomState?: () => string;
  randomVerifier?: () => string;
  allowInsecureLocalDevelopment?: boolean;
}

export class CloudAuthManager {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly randomState: () => string;
  private readonly randomVerifier: () => string;

  constructor(private readonly dependencies: CloudAuthManagerDependencies) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.randomState =
      dependencies.randomState ?? (() => randomBytes(32).toString("base64url"));
    this.randomVerifier =
      dependencies.randomVerifier ??
      (() => randomBytes(32).toString("base64url"));
  }

  async status(): Promise<CloudAccountStatus> {
    const storedAccount = await this.readJson<unknown>(CLOUD_ACCOUNT_FILE);
    let account = isCloudAccount(storedAccount) ? storedAccount : null;
    if (account?.base_url === LEGACY_CLOUD_BASE_URL) {
      account = await this.migrateLegacyAccount(account);
    }
    if (account && (await this.dependencies.getSecret(account.base_url))) {
      return { state: "connected", account };
    }

    const pending = await this.readPending();
    if (pending) return { state: "connecting", account: null };
    return { state: "disconnected", account: null };
  }

  async connect(
    baseUrl: string,
    callbackUrl?: string,
  ): Promise<CloudAccountConnectResult> {
    const normalizedBaseUrl = normalizeCloudBaseUrl(
      baseUrl,
      this.dependencies.allowInsecureLocalDevelopment ?? false,
    );
    const expiresAt = new Date(this.now().getTime() + AUTH_LIFETIME_MS);
    const state = this.randomState();
    const codeVerifier = this.randomVerifier();
    if (!isBoundedState(state) || !isCodeVerifier(codeVerifier)) {
      throw new Error(
        "ZenNotes could not create a secure cloud sign-in request.",
      );
    }
    const pending: PendingCloudAuth = {
      base_url: normalizedBaseUrl,
      state,
      code_verifier: codeVerifier,
      expires_at: expiresAt.toISOString(),
    };
    await this.writeJson(PENDING_AUTH_FILE, pending);

    const authorizationUrl = new URL("/app/connect", `${normalizedBaseUrl}/`);
    authorizationUrl.searchParams.set("state", pending.state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      createCodeChallenge(codeVerifier),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    if (callbackUrl) {
      if (!isLoopbackCallbackUrl(callbackUrl)) {
        await this.removeFile(PENDING_AUTH_FILE);
        throw new Error("ZenNotes created an invalid local sign-in callback.");
      }
      authorizationUrl.searchParams.set("callback_url", callbackUrl);
    }
    try {
      await this.dependencies.openExternal(authorizationUrl.toString());
    } catch (error) {
      await this.removeFile(PENDING_AUTH_FILE);
      throw error;
    }

    return {
      authorization_url: authorizationUrl.toString(),
      expires_at: pending.expires_at,
    };
  }

  async complete(
    request: CloudAuthDeepLinkRequest,
  ): Promise<CloudAccountStatus> {
    const pending = await this.readPending();
    if (!pending || !safeEquals(request.state, pending.state)) {
      throw new Error(
        "This ZenNotes Cloud sign-in request is invalid or has expired.",
      );
    }

    const response = await this.fetchImplementation(
      `${pending.base_url}/api/v1/app/exchange`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: request.code,
          state: request.state,
          code_verifier: pending.code_verifier,
          device_name: this.dependencies.deviceName,
          platform: "desktop",
          app_version: this.dependencies.appVersion,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = await parseExchangeResponse(response);
    if (!response.ok) {
      throw new Error(
        typeof payload.message === "string"
          ? payload.message
          : "ZenNotes Cloud rejected this sign-in request.",
      );
    }
    if (!isExchangeResponse(payload)) {
      throw new Error("ZenNotes Cloud returned an invalid sign-in response.");
    }
    if (!(await this.dependencies.setSecret(pending.base_url, payload.token))) {
      // On Linux this almost always means Chromium settled on its plaintext
      // key store because it did not recognize the desktop environment, so
      // point at the override instead of leaving a dead end.
      throw new Error(
        process.platform === "linux"
          ? "ZenNotes could not store the cloud credential securely on this device. " +
            "If a Secret Service keyring (such as gnome-keyring) is running, " +
            "launch ZenNotes with --password-store=gnome-libsecret and sign in again."
          : "ZenNotes could not store the cloud credential securely on this device.",
      );
    }

    const account: CloudAccount = {
      base_url: pending.base_url,
      user: payload.user,
      device: payload.device,
      connected_at: this.now().toISOString(),
    };
    await this.writeJson(CLOUD_ACCOUNT_FILE, account);
    await this.removeFile(PENDING_AUTH_FILE);

    return { state: "connected", account };
  }

  async logout(): Promise<CloudAccountStatus> {
    const storedAccount = await this.readJson<unknown>(CLOUD_ACCOUNT_FILE);
    const account = isCloudAccount(storedAccount) ? storedAccount : null;
    if (account) await this.dependencies.deleteSecret(account.base_url);
    await Promise.all([
      this.removeFile(CLOUD_ACCOUNT_FILE),
      this.removeFile(PENDING_AUTH_FILE),
    ]);
    return { state: "disconnected", account: null };
  }

  /** Move a legacy-origin account to the production origin: rewrite the
   *  stored base_url and re-key the credential. The token is deleted from the
   *  old key only after it is safely stored under the new one; if any step
   *  fails, the account is left exactly as it was. */
  private async migrateLegacyAccount(
    account: CloudAccount,
  ): Promise<CloudAccount> {
    const token = await this.dependencies.getSecret(account.base_url);
    if (!token) return account;
    if (!(await this.dependencies.setSecret(PRODUCTION_CLOUD_BASE_URL, token))) {
      return account;
    }
    const migrated: CloudAccount = {
      ...account,
      base_url: PRODUCTION_CLOUD_BASE_URL,
    };
    await this.writeJson(CLOUD_ACCOUNT_FILE, migrated);
    await this.dependencies.deleteSecret(account.base_url);
    return migrated;
  }

  private async readPending(): Promise<PendingCloudAuth | null> {
    const storedPending = await this.readJson<unknown>(PENDING_AUTH_FILE);
    if (!isPendingCloudAuth(storedPending)) return null;
    const pending = storedPending;
    if (new Date(pending.expires_at).getTime() > this.now().getTime())
      return pending;
    await this.removeFile(PENDING_AUTH_FILE);
    return null;
  }

  private async readJson<Value>(fileName: string): Promise<Value | null> {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(this.dependencies.storageDirectory, fileName),
          "utf8",
        ),
      ) as Value;
    } catch {
      return null;
    }
  }

  private async writeJson(fileName: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dependencies.storageDirectory, { recursive: true });
    const target = path.join(this.dependencies.storageDirectory, fileName);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  private async removeFile(fileName: string): Promise<void> {
    await fs.rm(path.join(this.dependencies.storageDirectory, fileName), {
      force: true,
    });
  }
}

export function resolveCloudBaseUrl(
  requestedBaseUrl: string | undefined,
  isPackaged: boolean,
  configuredDevelopmentBaseUrl?: string,
): string {
  if (isPackaged) return PRODUCTION_CLOUD_BASE_URL;

  return (
    requestedBaseUrl?.trim() ||
    configuredDevelopmentBaseUrl?.trim() ||
    DEVELOPMENT_CLOUD_BASE_URL
  );
}

export function normalizeCloudBaseUrl(
  baseUrl: string,
  allowInsecureLocalDevelopment = false,
): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("Enter a valid ZenNotes Cloud URL.");
  }

  const isLocalDevelopmentHost =
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.hostname.endsWith(".test");
  if (
    parsed.protocol !== "https:" &&
    !(
      allowInsecureLocalDevelopment &&
      isLocalDevelopmentHost &&
      parsed.protocol === "http:"
    )
  ) {
    throw new Error("ZenNotes Cloud must use HTTPS.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/"].includes(parsed.pathname)
  ) {
    throw new Error(
      "Enter the ZenNotes Cloud origin without a path, query, or credentials.",
    );
  }

  return parsed.origin;
}

function safeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

function isBoundedState(value: string): boolean {
  return (
    value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isCodeVerifier(value: string): boolean {
  return (
    value.length >= 43 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

function isLoopbackCallbackUrl(value: string): boolean {
  const match =
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/auth\/callback$/.exec(value);
  if (!match) return false;

  const port = Number(match[1]);
  return Number.isInteger(port) && port <= 65_535;
}

async function parseExchangeResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const payload = (await response.json()) as unknown;
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isExchangeResponse(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & CloudAuthExchangeResponse {
  const user = payload.user as Record<string, unknown> | undefined;
  const device = payload.device as Record<string, unknown> | undefined;
  return (
    typeof payload.token === "string" &&
    payload.token.length > 0 &&
    !!user &&
    typeof user.name === "string" &&
    typeof user.email === "string" &&
    !!device &&
    typeof device.id === "string" &&
    typeof device.name === "string" &&
    ["desktop", "ios", "android"].includes(String(device.platform))
  );
}

function isPendingCloudAuth(value: unknown): value is PendingCloudAuth {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingCloudAuth>;
  return (
    typeof pending.base_url === "string" &&
    typeof pending.state === "string" &&
    isBoundedState(pending.state) &&
    typeof pending.code_verifier === "string" &&
    isCodeVerifier(pending.code_verifier) &&
    typeof pending.expires_at === "string" &&
    Number.isFinite(new Date(pending.expires_at).getTime())
  );
}

function isCloudAccount(value: unknown): value is CloudAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<CloudAccount>;
  return (
    typeof account.base_url === "string" &&
    typeof account.connected_at === "string" &&
    !!account.user &&
    typeof account.user.name === "string" &&
    typeof account.user.email === "string" &&
    !!account.device &&
    typeof account.device.id === "string" &&
    typeof account.device.name === "string" &&
    ["desktop", "ios", "android"].includes(account.device.platform)
  );
}
