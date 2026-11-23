import { AuthRequiredError, AppError } from "../errors.js";
import type { CameraDevice, DailyStory, XiaomiSession } from "../types.js";
import { createEncryptedQuery, decryptBase64Rc4Response } from "./crypto.js";

const API_BASE = "https://api.io.mi.com/app";
const CAMERA_BASE = "https://business.smartcamera.api.io.mi.com";

interface XiaomiResponse<T> {
  code?: number;
  message?: string;
  msg?: string;
  result?: T;
  data?: T;
}

interface HomeEntry {
  id: string | number;
  name?: string;
  uid?: string | number;
}

interface HomeResponse {
  homelist?: HomeEntry[];
}

interface DeviceEntry {
  did?: string | number;
  model?: string;
  name?: string;
}

interface DeviceResponse {
  device_info?: DeviceEntry[] | null;
}

interface DailyStoryResponse {
  playUnits?: DailyStory[];
}

function parseJson<T>(payload: Uint8Array): T {
  const text = Buffer.from(payload).toString("utf8").replace(/^&&&START&&&/, "");
  return JSON.parse(text) as T;
}

function responseMessage(response: XiaomiResponse<unknown>): string {
  return response.message ?? response.msg ?? `米家接口返回业务码 ${String(response.code)}`;
}

export class XiaomiCloudClient {
  constructor(
    private readonly session: XiaomiSession,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private cookieHeader(): string {
    return [
      `userId=${this.session.userId}`,
      this.session.cUserId ? `cUserId=${this.session.cUserId}` : "",
      `yetAnotherServiceToken=${this.session.serviceToken}`,
      `serviceToken=${this.session.serviceToken}`,
      "locale=zh_CN",
      "timezone=GMT+08:00",
      "is_daylight=0",
      "dst_offset=0",
      "channel=MI_APP_STORE",
    ]
      .filter(Boolean)
      .join("; ");
  }

  private async requestBytes(options: {
    url: string;
    method: "GET" | "POST";
    data: string;
    camera: boolean;
    model?: string;
  }): Promise<Buffer> {
    const encrypted = createEncryptedQuery(
      options.method,
      options.url,
      options.data,
      this.session.ssecurity,
      { includeSsecurity: !options.camera },
    );
    const url = `${options.url}?${encrypted.fields.toString()}`;
    const headers: Record<string, string> = {
      "Accept-Encoding": "identity",
      "User-Agent": this.session.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
      Cookie: this.cookieHeader(),
    };
    if (options.model) {
      headers["MIOT-REQUEST-MODEL"] = options.model;
    }
    const response = await this.fetchImpl(url, {
      method: options.method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError();
    }
    if (!response.ok) {
      throw new AppError(
        `米家接口请求失败：HTTP ${response.status}`,
        "XIAOMI_HTTP_ERROR",
        502,
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (
      body.subarray(0, 7).toString("utf8") === "#EXTM3U" ||
      body[0] === 0x7b ||
      body[0] === 0x5b
    ) {
      return body;
    }
    return decryptBase64Rc4Response(encrypted.signedNonce, body);
  }

  private async requestJson<T>(options: {
    url: string;
    method: "GET" | "POST";
    data: unknown;
    camera: boolean;
    model?: string;
  }): Promise<XiaomiResponse<T>> {
    const payload = await this.requestBytes({
      ...options,
      data: JSON.stringify(options.data),
    });
    const response = parseJson<XiaomiResponse<T>>(payload);
    if (response.code !== undefined && response.code !== 0) {
      if (response.code === -6 || response.code === -3) {
        throw new AuthRequiredError(responseMessage(response));
      }
      throw new AppError(responseMessage(response), "XIAOMI_API_ERROR", 502);
    }
    return response;
  }

  async listCameras(): Promise<CameraDevice[]> {
    const homes = await this.requestJson<HomeResponse>({
      url: `${API_BASE}/v2/homeroom/gethome`,
      method: "POST",
      data: {
        fg: true,
        fetch_share: true,
        fetch_share_dev: true,
        limit: 300,
        app_ver: 7,
      },
      camera: false,
    });
    const entries = homes.result?.homelist ?? [];
    const devices: CameraDevice[] = [];
    for (const home of entries) {
      const ownerId = String(home.uid ?? this.session.userId);
      const response = await this.requestJson<DeviceResponse>({
        url: `${API_BASE}/v2/home/home_device_list`,
        method: "POST",
        data: {
          home_owner: Number(ownerId),
          home_id: Number(home.id),
          limit: 200,
          get_split_device: true,
          support_smart_home: true,
        },
        camera: false,
      });
      for (const device of response.result?.device_info ?? []) {
        const did = String(device.did ?? "");
        const model = device.model ?? "";
        if (!did || !model || !model.toLowerCase().includes("camera")) {
          continue;
        }
        devices.push({
          did,
          model,
          name: device.name?.trim() || model,
          homeId: String(home.id),
          homeName: home.name?.trim() || `家庭 ${String(home.id)}`,
          ownerId,
        });
      }
    }
    return Array.from(
      new Map(devices.map((device) => [`${device.homeId}\u0000${device.did}`, device])).values(),
    );
  }

  async listDailyStories(device: Pick<CameraDevice, "did" | "model">): Promise<DailyStory[]> {
    const response = await this.requestJson<DailyStoryResponse>({
      url: `${CAMERA_BASE}/miot/camera/app/v1/dailyStory/playlist`,
      method: "GET",
      data: {
        did: device.did,
        category: 1,
        model: device.model,
        endTime: Date.now(),
        limit: 30,
        region: "CN",
      },
      camera: true,
      model: device.model,
    });
    return response.data?.playUnits ?? [];
  }

  async getDailyStoryPlaylist(
    device: Pick<CameraDevice, "did" | "model">,
    fileId: string,
  ): Promise<Buffer> {
    const playlist = await this.requestBytes({
      url: `${CAMERA_BASE}/miot/camera/app/v1/dailyStory/m3u8`,
      method: "GET",
      data: JSON.stringify({ did: device.did, region: "CN", fileId }),
      camera: true,
      model: device.model,
    });
    if (!playlist.subarray(0, 7).equals(Buffer.from("#EXTM3U"))) {
      throw new AppError("米家没有返回有效的 HLS 清单。", "INVALID_PLAYLIST", 502);
    }
    return playlist;
  }
}
