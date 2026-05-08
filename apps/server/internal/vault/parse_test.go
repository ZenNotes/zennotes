package vault

import "testing"

func TestBodyHasLocalAssetDetectsOnlyLocalAssets(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "plain wikilink",
			body: "# Plain\n\n[[Project Note]]\n",
			want: false,
		},
		{
			name: "relative image",
			body: "# Image\n\n![diagram](../attachements/diagram.png)\n",
			want: true,
		},
		{
			name: "embedded pdf",
			body: "# Embed\n\n![[brief.pdf]]\n",
			want: true,
		},
		{
			name: "remote image",
			body: "# Remote\n\n![diagram](https://example.com/diagram.png)\n",
			want: false,
		},
		{
			name: "code fenced local asset",
			body: "# Code\n\n```md\n![diagram](local.png)\n```\n",
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := BodyHasLocalAsset(tc.body); got != tc.want {
				t.Fatalf("BodyHasLocalAsset() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExtractorsStillIgnoreCodeAfterFastPathGuards(t *testing.T) {
	body := "# Real #tag\n\n```md\n#ignored [[Ignored]] ![[ignored.pdf]]\n```\n\n[[Target|Label]]"

	tags := ExtractTags(body)
	if len(tags) != 1 || tags[0] != "tag" {
		t.Fatalf("ExtractTags() = %#v, want [tag]", tags)
	}

	wikilinks := ExtractWikilinks(body)
	if len(wikilinks) != 1 || wikilinks[0] != "Target" {
		t.Fatalf("ExtractWikilinks() = %#v, want [Target]", wikilinks)
	}
}
