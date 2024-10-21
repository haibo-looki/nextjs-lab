/* eslint-disable @typescript-eslint/no-unused-vars */

import {
  DownstreamMessage,
  DownstreamMessage_DataMessage,
  MessageData,
  UpstreamMessage,
} from "@/protos/azure-webpubsub";

// 基于 azure-webpubsub chatapp sample 修改
// see: https://github.com/Azure/azure-webpubsub/blob/main/samples/javascript/chatapp-reliable-subprotocol/public/client.js

export enum ConnectionStatus {
  Disconnected = "Disconnected",
  Connecting = "Connecting",
  Reconnecting = "Reconnecting",
  Connected = "Connected",
}

interface ConnectedMessage {
  userId: string | number;
  connectionId: string;
}

interface DisconnectedMessage {
  reason: string;
}

export interface AckMessage {
  ackId: string;
  success: boolean;
  error?: {
    name: "Forbidden" | "InternalServerError" | "Duplicate" | string;
    message?: string;
  };
}

interface AckHandler {
  deferred: Deferred<AckMessage>;
}

export class ReliableWebSocketClient {
  connection: WebSocket | null = null;
  connectionStatus = ConnectionStatus.Disconnected;
  lastReceivedSequenceId = "";
  ackHandler: Record<number | string, AckHandler> = {};
  reconnectionEndpoint?: URL;
  reconnectionInfo?: {
    connectionId: string;
    reconnectionToken: string;
  };
  closed = false;
  options: {
    negotiate: () => Promise<{ baseUrl: string; token: string }>;
    onMessage?: (msg: DownstreamMessage_DataMessage) => void;
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
      "protobuf.reliable.webpubsub.azure.v1"
    ));
    websocket.binaryType = "arraybuffer";
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
      const down_message = DownstreamMessage.fromBinary(
        new Uint8Array(e.data as ArrayBuffer)
      );

      if (down_message.message.oneofKind === "systemMessage") {
        const data = down_message.message.systemMessage;
        if (data.message.oneofKind === "connectedMessage") {
          this.connectionStatus = ConnectionStatus.Connected;
          this.reconnectionInfo = {
            connectionId: data.message.connectedMessage.connectionId,
            reconnectionToken: data.message.connectedMessage.reconnectionToken,
          };
          this.options.onConnected?.({
            userId: data.message.connectedMessage.userId,
            connectionId: data.message.connectedMessage.connectionId,
          });
        }
        if (data.message.oneofKind === "disconnectedMessage") {
          this.options.onDisconnected?.({
            reason: data.message.disconnectedMessage.reason,
          });
        }
      } else if (down_message.message.oneofKind === "ackMessage") {
        // ack 消息表示服务器已收到 client 发送的消息
        // 如 ack 消息包含失败信息，client 应进行重试
        const data = down_message.message.ackMessage;
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

        handleAck({
          ackId: data.ackId,
          success: data.success,
          error: data.error,
        });
      } else if (down_message.message.oneofKind === "dataMessage") {
        // 包含 sequence id 的消息，需要立即回复 ack
        const data = down_message.message.dataMessage;
        const sequenceId = data.sequenceId;
        if (sequenceId > this.lastReceivedSequenceId) {
          this.lastReceivedSequenceId = sequenceId;
        }
        this.send({
          message: {
            oneofKind: "sequenceAckMessage",
            sequenceAckMessage: { sequenceId: this.lastReceivedSequenceId },
          },
        });
        // 收到 server 发来的消息
        this.options.onMessage?.(data);
      }
    };
  }

  abort() {
    this.connection?.close(3001);
  }

  sendEvent(ackId: number | string, event_name: string, data: MessageData) {
    const deferred = new Deferred<AckMessage>();
    this.ackHandler[ackId] = {
      deferred,
    };

    try {
      if (this.connection?.readyState === WebSocket.OPEN) {
        this.send({
          message: {
            oneofKind: "eventMessage",
            eventMessage: {
              event: event_name,
              ackId: `${ackId}`,
              data,
            },
          },
        });
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

  send(data: UpstreamMessage) {
    this.connection?.send(UpstreamMessage.toBinary(data));
  }

  // 将 client 发送的所有未 ack 的消息标记失败
  cleanupAck() {
    const ackHandler = this.ackHandler;
    for (const key in ackHandler) {
      const value = ackHandler[key];
      value.deferred.reject({
        ackId: key,
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
