; ============================================================
;  DJ Mix  --  Windows installer (Inno Setup 6)
;
;  Build with build.ps1 in the repo root; it stages the app files
;  in dist\djmix and passes the version from djmix.js.
;
;  What it does:
;   * checks for the Spotify desktop app and Spicetify
;   * can install Spicetify for you if it's missing
;   * installs the DJ Mix app (which carries the DJ Mix extension)
;     into Spicetify, removes the old standalone extension, applies
;   * Start Menu: "Repair DJ Mix" for after Spotify updates
;   * per-user, no admin prompt; clean uninstaller in Settings > Apps
; ============================================================

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName      "DJ Mix for Spotify"
#define AppPublisher "DJ Mix contributors"
#define AppURL       "https://github.com/VanshCoder01/spicetify-DJ-MOD-automix"

[Setup]
AppId={{5E0B7C61-3A9D-4F2E-B8C4-7D1A9E6F2C35}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\DJ Mix
DisableDirPage=yes
DefaultGroupName=DJ Mix
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=DJMix-Setup-{#AppVersion}
SetupIconFile=djmix.ico
UninstallDisplayIcon={app}\djmix.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardImageFile=wizard-large.bmp,wizard-large@2x.bmp
WizardSmallImageFile=wizard-small.bmp,wizard-small@2x.bmp
WizardImageStretch=no
LicenseFile=..\LICENSE
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel2=This installs [name/ver] on your computer.%n%nDJ Mix turns on Spotify's hidden automix engine for every song you play: the next track slides in on the beat, tempo-locked, like a real DJ set. On Spotify Free it uses a smooth, recipe-timed fade instead.%n%nYou also get a DJ Mix page in Spotify's sidebar with live decks, a setlist forecast, the Mix Lab and all the settings.%n%nSpotify will restart once near the end.
FinishedLabel=DJ Mix is installed. Open Spotify and click DJ Mix in the sidebar.%n%nIf a Spotify update ever removes it, run "Repair DJ Mix" from the Start menu.

[Files]
Source: "..\dist\djmix\*"; DestDir: "{userappdata}\spicetify\CustomApps\djmix"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "djmix-setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "djmix.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\Repair DJ Mix (after a Spotify update)"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\djmix-setup.ps1"" -Action repair"; IconFilename: "{app}\djmix.ico"
Name: "{group}\DJ Mix on GitHub"; Filename: "{#AppURL}"
Name: "{group}\Uninstall DJ Mix"; Filename: "{uninstallexe}"; IconFilename: "{app}\djmix.ico"

[Run]
Filename: "{code:SpotifyExe}"; Description: "Open Spotify now"; Flags: postinstall nowait skipifsilent unchecked; Check: HasSpotify

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\djmix-setup.ps1"" -Action uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "DJMixUnregister"

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\spicetify\CustomApps\djmix"

[Code]
var
  CheckPage: TWizardPage;
  SpotifyLabel, SpicetifyLabel, NoteLabel: TNewStaticText;
  InstallSpicetifyBox: TNewCheckBox;

function SpotifyPath(): String;
begin
  Result := ExpandConstant('{userappdata}\Spotify\Spotify.exe');
end;

function HasSpotify(): Boolean;
begin
  Result := FileExists(SpotifyPath());
end;

function SpotifyExe(Param: String): String;
begin
  Result := SpotifyPath();
end;

function SpicetifyPath(): String;
begin
  Result := ExpandConstant('{localappdata}\spicetify\spicetify.exe');
  if not FileExists(Result) then
    Result := FileSearch('spicetify.exe', GetEnv('PATH'));
end;

function HasSpicetify(): Boolean;
begin
  Result := SpicetifyPath() <> '';
end;

procedure AddLabel(var L: TNewStaticText; Top: Integer; Bold: Boolean);
begin
  L := TNewStaticText.Create(CheckPage);
  L.Parent := CheckPage.Surface;
  L.Top := Top;
  L.Width := CheckPage.SurfaceWidth;
  L.AutoSize := False;
  L.WordWrap := True;
  L.Height := ScaleY(40);
  if Bold then L.Font.Style := [fsBold];
end;

procedure InitializeWizard();
begin
  CheckPage := CreateCustomPage(wpLicense, 'Checking your setup',
    'DJ Mix runs inside the Spotify desktop app through Spicetify.');

  AddLabel(SpotifyLabel, 0, True);
  AddLabel(SpicetifyLabel, ScaleY(48), True);

  InstallSpicetifyBox := TNewCheckBox.Create(CheckPage);
  InstallSpicetifyBox.Parent := CheckPage.Surface;
  InstallSpicetifyBox.Top := ScaleY(96);
  InstallSpicetifyBox.Width := CheckPage.SurfaceWidth;
  InstallSpicetifyBox.Height := ScaleY(20);
  InstallSpicetifyBox.Caption := 'Install Spicetify for me (downloads the official installer from spicetify.app)';
  InstallSpicetifyBox.Checked := True;

  AddLabel(NoteLabel, ScaleY(128), False);
  NoteLabel.Height := ScaleY(90);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> CheckPage.ID then Exit;
  if HasSpotify() then
    SpotifyLabel.Caption := 'OK: Spotify desktop app found.'
  else
    SpotifyLabel.Caption := 'Missing: Spotify desktop app not found in %APPDATA%\Spotify. Install it from spotify.com/download ' +
      '(the Microsoft Store version doesn''t work with Spicetify).';

  if HasSpicetify() then begin
    SpicetifyLabel.Caption := 'OK: Spicetify found at ' + SpicetifyPath();
    InstallSpicetifyBox.Visible := False;
    NoteLabel.Caption := 'Any older DJ Mix extension will be replaced by this version. Your settings, history and stats are kept.';
  end else begin
    SpicetifyLabel.Caption := 'Missing: Spicetify isn''t installed yet.';
    InstallSpicetifyBox.Visible := True;
    NoteLabel.Caption := 'If you let the installer get Spicetify, a console window opens and may ask whether to also ' +
      'install the Spicetify Marketplace. Answer there and the installer carries on.';
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = CheckPage.ID then begin
    if not HasSpotify() then
      Result := MsgBox('Spotify desktop wasn''t found. DJ Mix only works with the Spotify app from spotify.com.' + #13#10 +
        'Install anyway?', mbConfirmation, MB_YESNO) = IDYES
    else if (not HasSpicetify()) and (not InstallSpicetifyBox.Checked) then begin
      MsgBox('DJ Mix needs Spicetify. Tick "Install Spicetify for me", or install it from spicetify.app first.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Params, LogPath: String;
  Code, Show: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  LogPath := ExpandConstant('{tmp}\djmix-setup.log');
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\djmix-setup.ps1') +
    '" -Action install -Log "' + LogPath + '"';
  Show := SW_HIDE;
  if (not HasSpicetify()) and InstallSpicetifyBox.Checked then begin
    Params := Params + ' -InstallSpicetify';
    Show := SW_SHOW;
  end;
  WizardForm.StatusLabel.Caption := 'Setting up DJ Mix in Spotify (Spotify will restart)...';
  if not Exec('powershell.exe', Params, '', Show, ewWaitUntilTerminated, Code) or (Code <> 0) then begin
    FileCopy(LogPath, ExpandConstant('{app}\djmix-setup.log'), False);
    MsgBox('DJ Mix''s files are installed, but setting it up in Spotify didn''t finish (code ' + IntToStr(Code) + ').' + #13#10#13#10 +
      'Make sure Spotify from spotify.com and Spicetify are installed, then run "Repair DJ Mix" from the Start menu.' + #13#10 +
      'Details: ' + ExpandConstant('{app}\djmix-setup.log'), mbError, MB_OK);
  end;
end;
