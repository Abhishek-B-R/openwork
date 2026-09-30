"use client";
import { useState } from "react";
import { z } from "zod";
import { DenButton } from "../app/(den)/_components/ui/button";
import { DenTextarea } from "../app/(den)/_components/ui/textarea";
import { requestJson } from "../app/(den)/_lib/den-flow";
export function HeadlessReadActions({
  organizationId,
}: {
  organizationId: string;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  const path = `/v1/admin/organizations/${organizationId}/capabilities`;
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson(path);
      if (!result.response.ok)
        throw new Error(
          "Approved read actions could not be verified. Try again.",
        );
      setValue(
        z
          .object({ headlessReadCapabilities: z.array(z.string()) })
          .parse(result.payload)
          .headlessReadCapabilities.join("\n"),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not verify approved reads.",
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson(path, {
        method: "PUT",
        body: JSON.stringify({
          capabilities: {},
          headlessReadCapabilities: value
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      });
      if (!result.response.ok)
        throw new Error("Approved read actions were not saved. Try again.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save approved reads.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="mt-3" open={open}>
      <summary
        className="cursor-pointer text-sm"
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
          if (!open) void load();
        }}
      >
        Technical details
      </summary>
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-sm">
            Approved headless read actions
            <DenTextarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-label="Approved headless read actions"
              rows={3}
            />
          </label>
          <span className="text-xs text-[var(--dls-text-secondary)]">
            One exact capability name per line. Approve verified reads only.
          </span>
          {error ? (
            <p role="alert" className="text-[var(--ow-danger)]">
              {error}
            </p>
          ) : null}
          <DenButton disabled={busy} size="sm" onClick={() => void save()}>
            Save approved reads
          </DenButton>
        </div>
      ) : null}
    </details>
  );
}
