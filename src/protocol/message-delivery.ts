export type MessageOperation = "start" | "steer" | "queue" | "guide" | "promote";

export type MessageDelivery = {
  id: string;
  threadId: string;
  operation: MessageOperation;
  status: "accepted" | "delivered" | "failed" | "uncertain";
  text: string;
  messageId?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  error?: string;
};
