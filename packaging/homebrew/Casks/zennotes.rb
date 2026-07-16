cask "zennotes" do
  arch arm: "arm64", intel: "x64"

  version "2.13.4"
  sha256 arm:   "e754df1ba803b37cc6f04e68bec07fcaa8a835a3a0c32cb9695b805f2c952312",
         intel: "f5ae9934e2c17a231b2c268018e4cbe5f37b5efb22f15c6d00500dbbd9c3fc7d"

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
