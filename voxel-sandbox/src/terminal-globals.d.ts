declare const Buffer: {
  isBuffer(value: unknown): boolean;
};

type Buffer = {
  toString(encoding?: string): string;
};

declare const process: {
  argv: string[];
  stdin: {
    isTTY?: boolean;
    setRawMode(enabled: boolean): void;
    resume(): void;
    pause(): void;
    on(event: "data", listener: (buffer: Buffer) => void): void;
    off(event: "data", listener: (buffer: Buffer) => void): void;
  };
  stdout: {
    isTTY?: boolean;
    write(value: string): void;
  };
};
