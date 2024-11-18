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
  ConnectionStatus,
  ReliableWebSocketClient,
} from "@/lib/chattypal_client";
import { TextMessage } from "@/protos/test";
import { Any } from "@/protos/google/protobuf/any";
import { v4 as uuidv4 } from "uuid";

const token = process.env.NEXT_PUBLIC_AUTH_TOKEN;


msg_buffer: {}[] = [];

interface Message {
  id?: string;
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
      { ...msg, datetime: msg.datetime || new Date(), id: uuidv4() },
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
        url: `ws://${window.location.hostname}:8000/v1/realtime/ws`,
        token: `${token}`,
        onConnected: (msg) => {
          console.log("connected", msg);
          refreshClient();
        },
        onDisconnected: () => {
          console.log("disconnected");
          refreshClient();
        },
        onMessage: (msg) => {
          // 接收 Server 发送的消息
          console.log("received", msg);
          // text data
          if (msg.payload.oneofKind === "receipt") {
            updateMessage(msg.payload.receipt.msgId, { success: true });
            return;
          }
          // binary data
          if (msg.payload.oneofKind === "response") {
            const payload = msg.payload.response.data;
            if (payload.oneofKind === "text") {
              addMessage({
                ackId: 0,
                data: payload.text.content,
              });
            } else if (payload.oneofKind === "audio") {
              addMessage({
                ackId: 0,
                data: `[audio] length=${payload.audio.content.length}`,
              });
            } else if (payload.oneofKind === "image") {
              addMessage({
                ackId: 0,
                data: `[image] data=${payload.image.image}`,
              });
            } else if (payload.oneofKind === "started") {
              console.log(
                "started. reply to",
                msg.payload.response.replyToMsgId
              );
            } else if (payload.oneofKind === "ended") {
              console.log("ended. reply to", msg.payload.response.replyToMsgId);
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
  }, [refreshClient, updateMessage]);

  const reconnect = useCallback(async () => {
    client?.abort();
    await client?.connect();
  }, [client]);

  const [inputValue, setInputValue] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = useCallback(
    async (msg: Message) => {
      try {
        const ack = await client?.sendEvent({
          ackId: `${msg.ackId}`,
          common: {
            msgId: `${msg.ackId}`,
            audioOn: true,
            userCommon: {
              tz: "+08:00",
              tzId: "Asia/Shanghai",
              locale: "zh-Hans-CN",
              gnss: {
                country: "\u4e2d\u56fd",
                lat: 39.988180422174764,
                countryCode: "CN",
                adminArea: "",
                locality: "\u5317\u4eac\u5e02",
                subLocality: "\u6d77\u6dc0\u533a",
                lng: 116.33422998840214,
              },
            },
          },
          payload: {
            oneofKind: "text",
            text: {
              charId: "1",
              content: `${msg.data}`,
            },
          },
        });
        if (ack) {
          if (!ack.success) {
            updateMessage(ack.ackId, { success: false });
          }
          console.log(`Received ack: ${ack}`);
        }
      } catch (ack) {
        updateMessage(msg.ackId, { success: false });
        console.error(`Failed:`, ack);
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
            isLoading={client?.connectionStatus === ConnectionStatus.Connecting}
            onClick={client ? reconnect : connect}
            isDisabled={client?.connectionStatus === ConnectionStatus.Connected}
          >
            {client
              ? client.connectionStatus === ConnectionStatus.Connected
                ? "Connected"
                : "Reconnect"
              : "Connect"}
          </Button>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onSubmit();
            }}
          >
            <Input
              placeholder="Type to chat..."
              disabled={
                isLoading ||
                client?.connectionStatus !== ConnectionStatus.Connected
              }
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
              <Card
                key={`${msg.ackId || msg.id}-${msg.datetime}`}
                className="w-full"
              >
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
