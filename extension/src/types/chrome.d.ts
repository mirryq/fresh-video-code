/**
 * 精简 Chrome Extension API 声明（MV3）。
 * 覆盖本项目用到的 runtime 消息能力；完整类型可后续换 @types/chrome。
 */

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      id?: string;
      tab?: { id?: number; url?: string };
      url?: string;
    }

    type SendResponse = (response?: unknown) => void;

    type MessageListener = (
      message: unknown,
      sender: MessageSender,
      sendResponse: SendResponse,
    ) => boolean | void | Promise<unknown>;

    const onMessage: {
      addListener(listener: MessageListener): void;
      removeListener(listener: MessageListener): void;
    };

    function sendMessage(message: unknown): Promise<unknown>;
    function sendMessage(
      message: unknown,
      responseCallback: (response: unknown) => void,
    ): void;
  }
}
