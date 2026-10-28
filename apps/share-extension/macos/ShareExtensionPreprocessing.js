// Safari runs this on the page being shared (NSExtensionJavaScriptPreprocessingFile
// in Info.plist) and hands the result to the share extension: the page's own
// title and address, and whatever is selected on it.
var ZenNotesSharePreprocessing = function () {}

ZenNotesSharePreprocessing.prototype = {
  run: function (args) {
    var selection = window.getSelection ? String(window.getSelection()) : ''
    args.completionFunction({ url: document.URL, title: document.title, selection: selection })
  }
}

var ExtensionPreprocessingJS = new ZenNotesSharePreprocessing()
