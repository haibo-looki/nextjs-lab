/* eslint-disable @typescript-eslint/no-unused-vars */

import {
  ServerMessage,
  ServerMessage_ServerEvent,
} from "@/protos/chattypal-server";

import { UserMessage, UserMessage_UserEvent } from "@/protos/chattypal-client";

export enum ConnectionStatus {
  Disconnected = "Disconnected",
  Connecting = "Connecting",
  Connected = "Connected",
}

interface ConnectedMessage {
  connectionId: string;
}

export interface AckMessage {
  ackId: string;
  success: boolean;
  error?: string;
}

interface AckHandler {
  deferred: Deferred<AckMessage>;
}

export class ReliableWebSocketClient {
  connection: WebSocket | null = null;
  connectionStatus = ConnectionStatus.Disconnected;
  connectionId = "";
  lastReceivedSequenceId = "";
  waitingList: Record<number | string, AckHandler> = {};
  closed = false;
  options: {
    url: string;
    token: string;
    onMessage?: (msg: ServerMessage_ServerEvent) => void;
    onConnected?: (msg: ConnectedMessage) => void;
    onDisconnected?: () => void;
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
      await this.connectCore();
    } catch (err) {
      this.options.log(`[${new Date().toISOString()}] Error: ${err}`);
    }
  }

  // 创建 WebSocket 连接
  async connectCore() {
    const waitConnected = new Deferred();
    const websocket = (this.connection = new WebSocket(this.options.url, [
      "realtime.looki.v1",
      `looki-jwt-${this.options.token}`,
    ]));
    websocket.binaryType = "arraybuffer";
    websocket.onopen = (e) => {
      this.options.log(`[${new Date().toISOString()}] WebSocket opened.`, e);
    };
    websocket.onclose = (e) => {
      this.options.log(`[${new Date().toISOString()}] WebSocket closed.`, e);
      this.options.onDisconnected?.();
      this.cleanupAck();

      // 彻底断开连接，需要手动重连
      this.connectionStatus = ConnectionStatus.Disconnected;
      this.options.log(
        `[${new Date().toISOString()}] Connection ${
          this.connectionId
        } disconnected.`
      );
    };
    websocket.onerror = (e) => {
      this.options.log(`[${new Date().toISOString()}] WebSocket error`, e);
    };
    websocket.onmessage = (e) => {
      const down_message = ServerMessage.fromBinary(
        new Uint8Array(e.data as ArrayBuffer)
      );

      if (down_message.message.oneofKind === "ack") {
        // ack 消息表示服务器已收到 client 发送的消息
        // 如 ack 消息包含失败信息，client 应进行重试
        const data = down_message.message.ack;
        const handleAck = (ackMessage: AckMessage) => {
          const item = this.waitingList[ackMessage.ackId];
          if (item !== null) {
            if (ackMessage.success) {
              item.deferred.resolve(ackMessage);
            } else {
              item.deferred.reject(ackMessage);
            }

            delete this.waitingList[ackMessage.ackId];
          }
        };

        // ack 之前的消息全部标记为 failure
        for (const key in this.waitingList) {
          if (key >= data.ackId) {
            continue;
          }
          const value = this.waitingList[key];
          value.deferred.reject({
            ackId: key,
            success: false,
            error: { name: "Timeout" },
          });
          delete this.waitingList[key];
        }

        handleAck({
          ackId: data.ackId,
          success: data.success,
          error: data.error,
        });
      } else if (down_message.message.oneofKind === "event") {
        const data = down_message.message.event;
        if (data.payload.oneofKind === "connected") {
          if (this.connectionStatus == ConnectionStatus.Connecting) {
            this.connectionStatus = ConnectionStatus.Connected;
            this.options.log(
              `[${new Date().toISOString()}] WebSocket connected.`
            );
          }
          this.connectionId = data.payload.connected.connectionId;
          this.options.onConnected?.({
            connectionId: data.payload.connected.connectionId,
          });
          return;
        }
        // 包含 sequence id 的消息，需要立即回复 ack
        if (data.seqId > this.lastReceivedSequenceId) {
          this.lastReceivedSequenceId = data.seqId;
          this.send({
            message: {
              oneofKind: "seqAck",
              seqAck: { seqId: this.lastReceivedSequenceId },
            },
          });
        }
        // 收到 server 发来的消息
        this.options.onMessage?.(data);
      }
    };
  }

  abort() {
    this.connection?.close(3001);
  }

  sendEvent(data: UserMessage_UserEvent) {
    const ackId = data.ackId;
    const deferred = new Deferred<AckMessage>();
    this.waitingList[ackId] = {
      deferred,
    };

    try {
      if (this.connection?.readyState === WebSocket.OPEN) {
        this.send({
          message: {
            oneofKind: "event",
            event: data,
          },
        });

        // 超时断连
        delay(5000).then(() => {
          if (this.waitingList[ackId]) {
            this.abort();
          }
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

  send(data: UserMessage) {
    this.connection?.send(UserMessage.toBinary(data));
  }

  // 将 client 发送的所有未 ack 的消息标记失败
  cleanupAck() {
    const ackHandlers = this.waitingList;
    for (const key in ackHandlers) {
      const value = ackHandlers[key];
      value.deferred.reject({
        ackId: key,
        success: false,
        error: { name: "Timeout" },
      });
      delete ackHandlers[key];
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
