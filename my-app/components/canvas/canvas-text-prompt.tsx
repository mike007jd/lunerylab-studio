"use client";

/**
 * In-canvas text prompt — replaces the native window.prompt (no styling, no
 * focus management, blocks the main thread). `askText` opens a controlled
 * shadcn Dialog and resolves with the trimmed value on confirm, or null on
 * cancel / dismiss. One dialog instance is reused; concurrent calls are not
 * expected (each is awaited from a user-gated button handler).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasCopy } from "@/components/canvas/canvas-copy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export interface CanvasTextPromptBinding {
  open: boolean;
  title: string;
  placeholder: string;
  required: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface CanvasTextPrompt {
  askText: (opts: {
    title: string;
    placeholder?: string;
    defaultValue?: string;
    required?: boolean;
  }) => Promise<string | null>;
  prompt: CanvasTextPromptBinding;
}

export function useCanvasTextPrompt(): CanvasTextPrompt {
  const [promptState, setPromptState] = useState<{
    open: boolean;
    title: string;
    placeholder: string;
    defaultValue: string;
    required: boolean;
    resolve: ((value: string | null) => void) | null;
  }>({
    open: false,
    title: "",
    placeholder: "",
    defaultValue: "",
    required: false,
    resolve: null,
  });
  const [promptValue, setPromptValue] = useState("");

  const askText = useCallback(
    (opts: {
      title: string;
      placeholder?: string;
      defaultValue?: string;
      required?: boolean;
    }): Promise<string | null> =>
      new Promise((resolve) => {
        setPromptValue(opts.defaultValue ?? "");
        setPromptState({
          open: true,
          title: opts.title,
          placeholder: opts.placeholder ?? "",
          defaultValue: opts.defaultValue ?? "",
          required: opts.required ?? false,
          resolve,
        });
      }),
    [],
  );

  const closePrompt = useCallback(
    (value: string | null) => {
      promptState.resolve?.(value);
      setPromptState((prev) => ({ ...prev, open: false, resolve: null }));
    },
    [promptState],
  );

  const confirmPrompt = useCallback(() => {
    const trimmed = promptValue.trim();
    if (promptState.required && !trimmed) return; // required + empty → no-op
    closePrompt(trimmed);
  }, [promptValue, promptState.required, closePrompt]);

  const cancelPrompt = useCallback(() => {
    closePrompt(null);
  }, [closePrompt]);

  return {
    askText,
    prompt: {
      open: promptState.open,
      title: promptState.title,
      placeholder: promptState.placeholder,
      required: promptState.required,
      value: promptValue,
      onValueChange: setPromptValue,
      onConfirm: confirmPrompt,
      onCancel: cancelPrompt,
    },
  };
}

/** In-canvas prompt for the inpaint description. */
export function CanvasTextPromptDialog({
  prompt,
  copy,
}: {
  prompt: CanvasTextPromptBinding;
  copy: CanvasCopy;
}) {
  const { open, title, placeholder, required, value, onValueChange, onConfirm, onCancel } =
    prompt;
  // Callback ref instead of a forwardRef on the shadcn Textarea (which is a
  // plain function component and would drop a passed ref). We focus + select
  // the element via this ref when the dialog opens.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the input when the dialog opens (Radix focuses DialogContent by
  // default; we want the caret in the field).
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Closing via Escape / overlay / X resolves the pending askText with
        // null (treated as cancel).
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Textarea
          ref={(el) => {
            inputRef.current = el;
          }}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onConfirm();
            }
          }}
          placeholder={placeholder}
          rows={3}
          className="resize-none"
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={onConfirm}
            disabled={required && !value.trim()}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
