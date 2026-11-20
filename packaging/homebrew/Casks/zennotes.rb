cask "zennotes" do
  arch arm: "arm64", intel: "x64"

  version "2.90.0"
  sha256 arm:   "9d7adb61b0dd9d7ff31196a7103d91c85e2b42740b526b77f61c3fc99d06b2db",
         intel: "2c588670dcb97ac0014e4e0a9623661afe74a7f492a4b36006dcf97c923bb2b2"

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
