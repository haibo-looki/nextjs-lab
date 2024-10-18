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
} from "@/lib/reliable_client";

const endpoint = "http://127.0.0.1:8000/v1/pubsub";
const token =
  "eyJhbGciOiJIUzI1NiIsImtpZCI6ImNqYWt5cnlnaEl0M3VkaDgiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3hmZ3plaW1ranV5dHZqc3N3bGJnLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJjMWNjYjVkNy0yNTQyLTRhM2UtYmQyZS1kNDAzMzJlZTRhNmIiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzI5NjY4Mzk4LCJpYXQiOjE3MjkwNjM1OTgsImVtYWlsIjoibGl1aGFpYm9AbG9va2kuYWkiLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6ImVtYWlsIiwicHJvdmlkZXJzIjpbImVtYWlsIl19LCJ1c2VyX21ldGFkYXRhIjp7ImVtYWlsIjoibGl1aGFpYm9AbG9va2kuYWkiLCJlbWFpbF92ZXJpZmllZCI6ZmFsc2UsInBob25lX3ZlcmlmaWVkIjpmYWxzZSwic3ViIjoiYzFjY2I1ZDctMjU0Mi00YTNlLWJkMmUtZDQwMzMyZWU0YTZiIn0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoib3RwIiwidGltZXN0YW1wIjoxNzI5MDYzNTk4fV0sInNlc3Npb25faWQiOiI3MDdlYWVhMi02MjNjLTQ3MjgtOWE3YS1kNTBiZDI0YmRmMjkiLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.tNFm3NmtHbeRhkcy-FjXU5NOOJVd0S4FcsZLE0K6wng";

interface Message {
  ackId: number;
  data: unknown;
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
    (ackId: number, updates: Partial<Omit<Message, "ackId">>) => {
      console.log(`update ${ackId}: ${JSON.stringify(updates)}`);
      setMessages((msgs) => {
        const msg = msgs.find((msg) => msg.ackId === ackId);
        if (msg) {
          Object.assign(msg, updates);
        }
        return [...msgs];
      });
    },
    []
  );

  const [client, setClient] = useState<ReliableWebSocketClient>();

  // 周期刷新 client 的状态（React 发现不了对象内部的变化）
  useEffect(() => {
    const intervalId = setInterval(() => {
      setClient((client) => (client ? client : client));
    }, 500);
    return () => clearInterval(intervalId);
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
        },
        onDisconnected: (msg) => {
          console.log("disconnected", msg);
        },
        onMessage: (msg) => {
          console.log("received", msg);
          addMessage({
            ackId: 0,
            data: `${JSON.stringify(msg.data)}`,
          });
        },
        log: console.log,
      });
      client.connect().catch((err) => {
        console.error("connection failed", err);
      });
      return client;
    });
  }, []);

  const reconnect = useCallback(() => {
    client?.abort();
  }, [client]);

  const [inputValue, setInputValue] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const ackId = useRef(0);

  const sendMessage = useCallback(
    async (msg: Message) => {
      const ack = await client?.sendEvent(msg.ackId, msg.data);
      if (ack) {
        if (ack.success == true) {
          updateMessage(ack.ackId, { success: true });
        } else {
          updateMessage(ack.ackId, { success: false });
          console.error(`Failed: ${ack.error}`);
        }
      }
    },
    [client, updateMessage]
  );

  const onSubmit = useCallback(async () => {
    if (!inputValue) return;

    setIsLoading(true);
    try {
      ackId.current++;
      const msg = {
        ackId: ackId.current,
        data: {
          content: inputValue,
        },
      };
      addMessage(msg);
      sendMessage(msg);

      setInputValue("");
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, ackId, sendMessage]);

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
              console.log("submit");
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
