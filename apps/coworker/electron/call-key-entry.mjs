import { execFile } from "node:child_process";

/** The long-lived key is typed into an OS-owned masked field, never a web renderer or IPC. */
export function requestCallKey(platform = process.platform) {
  const prompt = "OpenAI API key for Voice calls. Audio usage bills your OpenAI account.";
  let file, args;
  if (platform === "darwin") {
    file = "/usr/bin/osascript";
    args = ["-e", `text returned of (display dialog "${prompt}" with title "Open Coworker · OpenAI" default answer "" with hidden answer buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel")`];
  } else if (platform === "win32") {
    file = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $form=New-Object Windows.Forms.Form; $form.Text='Open Coworker · OpenAI'; $form.Width=480; $form.Height=210; $label=New-Object Windows.Forms.Label; $label.Text='${prompt}'; $label.SetBounds(16,16,440,45); $field=New-Object Windows.Forms.TextBox; $field.UseSystemPasswordChar=$true; $field.SetBounds(16,66,430,26); $save=New-Object Windows.Forms.Button; $save.Text='Save'; $save.SetBounds(346,106,100,30); $save.DialogResult=[Windows.Forms.DialogResult]::OK; $form.Controls.AddRange(@($label,$field,$save)); $form.AcceptButton=$save; if($form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK){[Console]::Write($field.Text)}`];
  } else {
    file = "zenity"; args = ["--entry", "--hide-text", "--title=Open Coworker · OpenAI", `--text=${prompt}`];
  }
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 4096, timeout: 180_000, windowsHide: true }, (error, stdout) => {
      // execFile errors may carry stdout, so never propagate them.
      if (error) { if (error.code === "ENOENT") reject(new Error("Secure key entry is unavailable on this computer.")); else resolve(null); return; }
      resolve(stdout.trim() || null);
    });
  });
}
