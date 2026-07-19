Option Explicit

Dim shell, fileSystem, scriptDirectory, syncScript, localPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
syncScript = fileSystem.BuildPath(scriptDirectory, "sync-cloudbridge.ps1")
localPath = "D:\Cloud Bridge"
If WScript.Arguments.Count > 0 Then localPath = WScript.Arguments(0)
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & syncScript & """ -LocalPath """ & localPath & """"

shell.Run command, 0, True
