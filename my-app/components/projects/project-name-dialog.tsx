"use client";

import { useId, useRef, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PROJECT_NAME_MAX_LENGTH, normalizeProjectName } from "@/lib/project-name";

interface ProjectNameDialogProps {
  open: boolean;
  name: string;
  title: string;
  description: string;
  inputLabel: string;
  submitLabel: string;
  cancelLabel: string;
  pending?: boolean;
  error?: string;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void | Promise<void>;
}

export function ProjectNameDialog({
  open,
  name,
  title,
  description,
  inputLabel,
  submitLabel,
  cancelLabel,
  pending = false,
  error = "",
  onNameChange,
  onOpenChange,
  onSubmit,
}: ProjectNameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const inputId = useId();
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  const normalizedName = normalizeProjectName(name);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedName || pending || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onSubmit(normalizedName);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <DialogContent
        showCloseButton={false}
        className="border-(--border-subtle) bg-(--bg-surface) text-(--text-primary) sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription id={descriptionId}>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor={inputId} className="text-sm font-medium text-(--text-primary)">
              {inputLabel}
            </label>
            <Input
              ref={inputRef}
              id={inputId}
              value={name}
              maxLength={PROJECT_NAME_MAX_LENGTH}
              disabled={pending}
              aria-invalid={!normalizedName}
              aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </div>
          {error ? <p id={errorId} role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghostMuted"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button type="submit" variant="accent" loading={pending} disabled={!normalizedName}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
