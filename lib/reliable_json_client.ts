/* eslint-disable @typescript-eslint/no-unused-vars */

// 基于 azure-webpubsub chatapp sample 修改
// see: https://github.com/Azure/azure-webpubsub/blob/main/samples/javascript/chatapp-reliable-subprotocol/public/client.js

export enum ConnectionStatus {
  Disconnected = "Disconnected",
  Connecting = "Connecting",
  Reconnecting = "Reconnecting",
  Connected = "Connected",
}

interface ConnectedMessage {
  type: "system";
  event: "connected";
  userId: string | number;
  connectionId: string;
  reconnectionToken: string;
}

interface DisconnectedMessage {
  type: "system";
  event: "disconnected";
  message: string;
}

interface ServerMessage {
  sequenceId: number;
  type: "message";
  from: "server";
  dataType: "json" | "text" | "binary";
  data: unknown;
}

interface AckMessage {
  ackId: number;
  success: boolean;
  error?: {
    name: "Forbidden" | "InternalServerError" | "Duplicate" | string;
    message?: string;
  };
}

interface AckHandler {
  data: unknown;
  deferred: Deferred<AckMessage>;
}

export class ReliableWebSocketClient {
  connection: WebSocket | null = null;
  connectionStatus = ConnectionStatus.Disconnected;
  lastReceivedSequenceId = 0;
  ackHandler: Record<number, AckHandler> = {};
  reconnectionEndpoint?: URL;
  reconnectionInfo?: {
    connectionId: string;
    reconnectionToken: string;
  };
  closed = false;
  options: {
    negotiate: () => Promise<{ baseUrl: string; token: string }>;
    onMessage?: (msg: ServerMessage) => void;
    onConnected?: (msg: ConnectedMessage) => void;
    onDisconnected?: (msg: DisconnectedMessage) => void;
    log: typeof console.log;
  };

  constructor(options: typeof this.options) {
    this.options = options;
  }

  // 断开连接，并将所有未 ack 的消息标记为失败
  close() {
    this.closed = true;
    this.cleanupAck();

    this.connection?.close();
  }

  // 新建连接
  // Step 1: 调用 negotiate 接口，获取 access token
  // Step 2: 调用 connectCore 创建 WebSocket 连接
  async connect() {
    this.options.log(`[${new Date().toISOString()}] WebSocket connecting.`);

    this.connectionStatus = ConnectionStatus.Connecting;
    try {
      const { baseUrl, token } = await this.options.negotiate();
      this.reconnectionEndpoint = new URL(baseUrl);
      this.connectCore(`${baseUrl}?access_token=${token}`);
    } catch (err) {
      this.options.log(`[${new Date().toISOString()}] Error: ${err}`);
    }
  }

  // 尝试恢复连接
  // Step 1: 至少成功连接过一次，否则 fallback 到新建连接
  // Step 2: 使用 reconnection token 创建 WebSocket 连接
  // Step 3: 如 Step 2 无法连接，fallback 到新建连接
  reconnect() {
    if (this.reconnectionEndpoint && this.reconnectionInfo) {
      this.options.log(
        `[${new Date().toISOString()}] Client ${
          this.reconnectionInfo.connectionId
        } Reconnecting.`
      );
      this.reconnectionEndpoint.search = `?awps_connection_id=${this.reconnectionInfo.connectionId}&awps_reconnection_token=${this.reconnectionInfo.reconnectionToken}`;

      try {
        this.connectCore(this.reconnectionEndpoint.href);
      } catch (err) {
        this.options.log(`[${new Date().toISOString()}] Error: ` + err);
        delay(1000).then(() => this.reconnect());
      }
    } else {
      this.connect();
    }
  }

  // 创建 WebSocket 连接
  connectCore(url: string) {
    const websocket = (this.connection = new WebSocket(
      url,
      "json.reliable.webpubsub.azure.v1"
    ));
    websocket.onopen = (e) => {
      if (this.connectionStatus == ConnectionStatus.Reconnecting)
        this.connectionStatus = ConnectionStatus.Connected;
      this.options.log(`[${new Date().toISOString()}] WebSocket opened.`);
    };
    websocket.onclose = (e) => {
      this.options.log(`[${new Date().toISOString()}] WebSocket closed.`);
      this.cleanupAck();

      if (!this.closed && e.code != 1008) {
        // code=1008 是特殊错误码，表示服务器无法恢复重连
        this.connectionStatus = ConnectionStatus.Reconnecting;
        delay(1000).then(() => this.reconnect());
      } else {
        // 彻底断开连接，需要手动重连
        this.connectionStatus = ConnectionStatus.Disconnected;
        this.options.log(
          `[${new Date().toISOString()}] Connection ${
            this.reconnectionInfo?.connectionId
          } disconnected.`
        );
      }
    };
    websocket.onerror = (e) => {
      this.options.log(
        `[${new Date().toISOString()}] WebSocket error, check the Console window for details.`
      );
    };
    websocket.onmessage = (e) => {
      const data = JSON.parse(e.data);
      // 包含 sequence id 的消息，需要立即回复 ack
      if (data.sequenceId) {
        const sequenceId = data.sequenceId;
        if (sequenceId > this.lastReceivedSequenceId) {
          this.lastReceivedSequenceId = sequenceId;
        }
        this.send(
          JSON.stringify({
            type: "sequenceAck",
            sequenceId: this.lastReceivedSequenceId,
          })
        );
      }

      if (data.type === "system") {
        if (data.event === "connected") {
          this.connectionStatus = ConnectionStatus.Connected;
          this.reconnectionInfo = {
            connectionId: data.connectionId,
            reconnectionToken: data.reconnectionToken,
          };
          this.options.onConnected?.(data);
        }
        if (data.event === "disconnected") {
          this.options.onDisconnected?.(data);
        }
      } else if (data.type === "ack") {
        // ack 消息表示服务器已收到 client 发送的消息
        // 如 ack 消息包含失败信息，client 应进行重试
        const handleAck = (ackMessage: AckMessage) => {
          const item = this.ackHandler[ackMessage.ackId];
          if (item !== null) {
            if (
              ackMessage.success === true ||
              ackMessage.error?.name === "Duplicate"
            ) {
              item.deferred.resolve(ackMessage);
            } else {
              item.deferred.reject(ackMessage);
            }

            delete this.ackHandler[ackMessage.ackId];
          }
        };

        handleAck(data);
      } else if (data.type === "message") {
        // 收到 server 发来的消息
        this.options.onMessage?.(data);
      }
    };
  }

  abort() {
    this.connection?.close(3001);
  }

  sendEvent(ackId: number, data: unknown, dataType = "json") {
    const msg = JSON.stringify({
      type: "event",
      event: "message",
      dataType,
      data,
      ackId,
    });

    const deferred = new Deferred<AckMessage>();
    this.ackHandler[ackId] = {
      data: msg,
      deferred,
    };

    try {
      if (this.connection?.readyState === WebSocket.OPEN) {
        this.connection.send(msg);
      } else {
        deferred.reject({
          ackId: ackId,
          success: false,
          error: { name: "Failed" },
        });
      }
    } catch (error) {
      console.log(error);
      deferred.reject({
        ackId: ackId,
        success: false,
        error: { name: "Failed" },
      });
    }

    return deferred.promise;
  }

  send(data: string) {
    this.connection?.send(data);
  }

  // 将 client 发送的所有未 ack 的消息标记失败
  cleanupAck() {
    const ackHandler = this.ackHandler;
    for (const key in ackHandler) {
      const value = ackHandler[key];
      value.deferred.reject({
        ackId: parseInt(key),
        success: false,
        error: { name: "Timeout" },
      });
      delete ackHandler[key];
    }
  }
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  then = (
    onfulfilled?: (value: T) => unknown,
    onrejected?: (reason: unknown) => unknown
  ) => {
    return this.promise.then(onfulfilled, onrejected);
  };

  catch = (onrejected?: (reason: unknown) => unknown) => {
    return this.promise.catch(onrejected);
  };

  finally = (onfinally?: () => unknown) => {
    return this.promise.finally(onfinally);
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
