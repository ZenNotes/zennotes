cask "zennotes" do
  arch arm: "arm64", intel: "x64"

  version "2.79.0"
  sha256 arm:   "9f323238a789abaf11cf39fbfa64f6547ca3a69de0835b62d5fe8c65b38d8c00",
         intel: "f053e49c73d6995476a6cdc37a2f731990f59b01b8a2b0b9a3ff8c55909bd830"

  url "https://github.com/ZenNotes/zennotes/releases/download/v#{version}/ZenNotes-#{version}-mac-#{arch}.dmg"
  name "ZenNotes"
  desc "Keyboard-first, local-first Markdown notes with vim motions and live preview"
  homepage "https://github.com/ZenNotes/zennotes"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app ships its own electron auto-updater, so let it update in place
  # rather than having Homebrew flag it as outdated on every release.
  auto_updates true
  depends_on macos: :monterey

  app "ZenNotes.app"

  zap trash: [
    "~/Library/Application Support/ZenNotes",
    "~/Library/Caches/com.adibhanna.zennotes",
    "~/Library/Caches/com.adibhanna.zennotes.ShipIt",
    "~/Library/HTTPStorages/com.adibhanna.zennotes",
    "~/Library/Logs/ZenNotes",
    "~/Library/Preferences/com.adibhanna.zennotes.plist",
    "~/Library/Saved Application State/com.adibhanna.zennotes.savedState",
  ]
end
