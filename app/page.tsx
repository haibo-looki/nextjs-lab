/* eslint-disable @typescript-eslint/no-unused-vars */
"use client";

import Image from "next/image";
import { Input } from "@nextui-org/input";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
} from "@nextui-org/react";
import {
  AckMessage,
  ConnectionStatus,
  ReliableWebSocketClient,
} from "@/lib/reliable_protobuf_client";
import { TextMessage } from "@/protos/test";
import { Any } from "@/protos/google/protobuf/any";

const endpoint = "http://127.0.0.1:8000/v1/pubsub";
const token = process.env.NEXT_PUBLIC_AUTH_TOKEN;

interface Message {
  ackId: string | number;
  data: string;
  success?: boolean;
  datetime?: Date;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    // { ackId: 0, content: "hello" },
    // { ackId: 1, content: "hello" },
    // { ackId: 2, content: "hello", success: true },
    // { ackId: 3, content: "hello", success: false },
  ]);
  const addMessage = (msg: Message) =>
    setMessages((msgs) => [
      ...msgs,
      { ...msg, datetime: msg.datetime || new Date() },
    ]);
  const updateMessage = useCallback(
    (ackId: number | string, updates: Partial<Omit<Message, "ackId">>) => {
      console.log(`update ${ackId}: ${JSON.stringify(updates)}`);
      setMessages((msgs) => {
        const msg = msgs.find(
          (msg) => msg.ackId.toString() === ackId.toString()
        );
        if (msg) {
          Object.assign(msg, updates);
        }
        return [...msgs];
      });
    },
    []
  );

  const [client, setClient] = useState<ReliableWebSocketClient>();

  // 刷新 client 的状态（React 发现不了对象内部的变化）
  const refreshClient = useCallback(() => {
    setClient((client) => {
      setTimeout(() => setClient(client), 100);
      return undefined;
    });
  }, []);

  const connect = useCallback(async () => {
    setClient((oldClient) => {
      oldClient?.close();
      const client = new ReliableWebSocketClient({
        negotiate: async () => {
          const res = await fetch(`${endpoint}/negotiate`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });
          return await res.json();
        },
        onConnected: (msg) => {
          console.log("connected", msg);
          refreshClient();
        },
        onDisconnected: (msg) => {
          console.log("disconnected", msg);
          refreshClient();
        },
        onMessage: (msg) => {
          // 接收 Server 发送的消息
          console.log("received", msg);
          // text data
          if (msg.data?.data.oneofKind === "textData") {
            addMessage({
              ackId: 0,
              data: msg.data.data.textData,
            });
            return;
          }
          // binary data
          if (msg.data?.data.oneofKind === "binaryData") {
            let data: Any | undefined;
            try {
              // 将 binary 当做 protobuf.Any 处理
              data = Any.fromBinary(msg.data.data.binaryData);
            } catch (e) {
              // unknown binary data
              addMessage({
                ackId: 0,
                data: `[binary] length=${msg.data.data.binaryData.length}`,
              });
              return;
            }
            // fallback to protobuf data
            msg.data.data = {
              oneofKind: "protobufData",
              protobufData: data,
            };
          }
          // protobuf message
          if (msg.data?.data.oneofKind === "protobufData") {
            const data = msg.data.data.protobufData;
            if (Any.contains(data, TextMessage)) {
              const user_text = Any.unpack(data, TextMessage);
              addMessage({
                ackId: 0,
                data: `${user_text.content}`,
              });
            } else {
              // unknown message
              addMessage({
                ackId: 0,
                data: `[${data.typeUrl}]`,
              });
            }
          }
        },
        log: console.log,
      });
      client.connect().catch((err) => {
        console.error("connection failed", err);
      });
      return client;
    });
  }, [refreshClient]);

  const reconnect = useCallback(() => {
    client?.abort();
  }, [client]);

  const [inputValue, setInputValue] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = useCallback(
    async (msg: Message) => {
      try {
        const ack = await client?.sendEvent(msg.ackId, "user_text", {
          data: {
            oneofKind: "protobufData",
            protobufData: Any.pack(
              TextMessage.create({ content: `${msg.data}` }),
              TextMessage
            ),
          },
        });
        if (ack) {
          updateMessage(ack.ackId, { success: ack.success });
        }
      } catch (ack) {
        updateMessage(msg.ackId, { success: false });
        console.error(`Failed: ${ack}`);
      }
    },
    [client, updateMessage]
  );

  const onSubmit = useCallback(async () => {
    if (!inputValue) return;

    setIsLoading(true);
    try {
      const msg = {
        ackId: new Date().valueOf(),
        data: inputValue,
      };
      addMessage(msg);
      sendMessage(msg);

      setInputValue("");
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, sendMessage]);

  const retrySubmit = useCallback(
    (msg: Message) => {
      updateMessage(msg.ackId, { success: undefined });
      sendMessage(msg);
    },
    [updateMessage, sendMessage]
  );
  return (
    <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start">
        <Image
          className="dark:invert"
          src="https://nextjs.org/icons/next.svg"
          alt="Next.js logo"
          width={180}
          height={38}
          priority
        />

        <div className="flex gap-4 items-center flex-col sm:flex-row">
          <Button
            isLoading={
              client?.connectionStatus === ConnectionStatus.Connecting ||
              client?.connectionStatus === ConnectionStatus.Reconnecting
            }
            onClick={client ? reconnect : connect}
          >
            {client ? "Reconnect" : "Connect"}
          </Button>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onSubmit();
            }}
          >
            <Input
              placeholder="Type to chat..."
              disabled={isLoading}
              value={inputValue}
              onValueChange={setInputValue}
            />
            <button
              className="hidden"
              type="submit"
              disabled={client?.connectionStatus !== ConnectionStatus.Connected}
            />
          </form>
        </div>
        <div className="flex flex-col w-[400px] gap-2">
          {messages.map((msg) => {
            return (
              <Card key={`${msg.ackId}-${msg.datetime}`} className="w-full">
                <CardBody>{msg.data as string}</CardBody>
                <Divider />
                <CardFooter className="flex-row-reverse gap-2">
                  {msg.datetime?.toLocaleString()}
                  {Boolean(msg.ackId) && msg.success === undefined && (
                    <Chip color="default">Sending...</Chip>
                  )}
                  {msg.success === true && <Chip color="success">✓</Chip>}
                  {msg.success === false && (
                    <>
                      <Chip color="danger">Error</Chip>
                      <Button onClick={() => retrySubmit(msg)}>Retry</Button>
                    </>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </main>
    </div>
  );
}
