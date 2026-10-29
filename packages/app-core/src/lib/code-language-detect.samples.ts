/**
 * Real snippets for the code block language guess (#1014): the kind of thing
 * people paste into a note, gathered to tune code-language-detect.ts and to
 * keep it honest. Test data only; nothing in the app imports this.
 */

/** Blocks the guess must name exactly: [tag, label, code]. */
export const DETECTED: ReadonlyArray<readonly [string, string, string]> = [
  ['python', 'python', `import os
from pathlib import Path


def find_notes(root: Path) -> list[Path]:
    """Return every markdown file under root."""
    notes = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(".md"):
                notes.append(Path(dirpath) / name)
    return sorted(notes)


if __name__ == "__main__":
    print(len(find_notes(Path.home() / "notes")))`],
  ['typescript', 'typescript', `interface Note {
  path: string
  title: string
  tags: readonly string[]
}

export function byTag(notes: Note[], tag: string): Note[] {
  return notes.filter((note): note is Note => note.tags.includes(tag))
}

const counts = new Map<string, number>()
for (const note of notes) {
  counts.set(note.title, (counts.get(note.title) ?? 0) + 1)
}`],
  ['javascript', 'javascript', `const express = require('express')
const app = express()

app.get('/notes/:id', async (req, res) => {
  const note = await db.notes.findOne({ id: req.params.id })
  if (!note) {
    return res.status(404).json({ error: 'not found' })
  }
  res.json(note)
})

app.listen(3000, () => console.log('listening on 3000'))`],
  ['rust', 'rust', `use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Note {
    pub title: String,
    pub tags: Vec<String>,
}

impl Note {
    pub fn new(title: &str) -> Self {
        Self { title: title.to_string(), tags: Vec::new() }
    }
}

fn count_tags(notes: &[Note]) -> HashMap<&str, usize> {
    let mut counts = HashMap::new();
    for note in notes {
        for tag in &note.tags {
            *counts.entry(tag.as_str()).or_insert(0) += 1;
        }
    }
    counts
}`],
  ['go', 'go', `package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	count := 0
	err := filepath.Walk(os.Args[1], func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if filepath.Ext(path) == ".md" {
			count++
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("%d notes\\n", count)
}`],
  ['json', 'json', `{
  "name": "zennotes",
  "version": "2.79.0",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test:run"
  },
  "engines": { "node": ">=20" }
}`],
  ['java', 'java', `package com.example.notes;

import java.util.ArrayList;
import java.util.List;

public class NoteIndex {
    private final List<String> titles = new ArrayList<>();

    public void add(String title) {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("title is required");
        }
        titles.add(title);
    }

    public static void main(String[] args) {
        NoteIndex index = new NoteIndex();
        index.add("Groceries");
        System.out.println(index.titles.size());
    }
}`],
  ['cpp', 'cpp', `#include <iostream>
#include <vector>
#include <string>

class Counter {
public:
    explicit Counter(int start) : value_(start) {}
    void increment() { ++value_; }
    int value() const { return value_; }
private:
    int value_;
};

int main() {
    std::vector<std::string> names{"a", "b", "c"};
    Counter counter(0);
    for (const auto& name : names) {
        counter.increment();
        std::cout << name << std::endl;
    }
    return 0;
}`],
  ['c', 'c', `#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s FILE\\n", argv[0]);
        return 1;
    }
    FILE *fp = fopen(argv[1], "r");
    if (fp == NULL) {
        perror("fopen");
        return 1;
    }
    int lines = 0;
    int ch;
    while ((ch = fgetc(fp)) != EOF) {
        if (ch == '\\n') lines++;
    }
    fclose(fp);
    printf("%d\\n", lines);
    return 0;
}`],
  ['html', 'html', `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Notes</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main class="notes">
      <h1>My notes</h1>
      <ul id="list"></ul>
    </main>
    <script src="app.js"></script>
  </body>
</html>`],
  ['css', 'css', `.note-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: #f7f7f5;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.note-card:hover {
  background-color: #efefec;
}

@media (max-width: 600px) {
  .note-card { padding: 8px; }
}`],
  ['sql', 'sql', `SELECT n.title, COUNT(t.id) AS tag_count
FROM notes AS n
LEFT JOIN note_tags AS t ON t.note_id = n.id
WHERE n.archived = FALSE
  AND n.updated_at > '2026-01-01'
GROUP BY n.title
HAVING COUNT(t.id) > 2
ORDER BY tag_count DESC
LIMIT 20;`],
  ['yaml', 'yaml', `name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test`],
  ['bash', 'bash', `#!/usr/bin/env bash
set -euo pipefail

VAULT="\${1:-$HOME/notes}"
if [[ ! -d "$VAULT" ]]; then
  echo "no vault at $VAULT" >&2
  exit 1
fi

for f in "$VAULT"/*.md; do
  lines=$(wc -l < "$f")
  echo "$(basename "$f"): $lines"
done | sort -t: -k2 -n`],
  ['ruby', 'ruby', `require 'json'

class Note
  attr_reader :title, :tags

  def initialize(title, tags = [])
    @title = title
    @tags = tags
  end

  def tagged?(tag)
    tags.include?(tag)
  end
end

notes = JSON.parse(File.read('notes.json')).map do |h|
  Note.new(h['title'], h['tags'])
end
puts notes.select { |n| n.tagged?('work') }.map(&:title)`],
  ['php', 'php', `<?php

namespace App\\Http\\Controllers;

use App\\Models\\Note;
use Illuminate\\Http\\Request;

class NoteController extends Controller
{
    public function index(Request $request)
    {
        $notes = Note::query()
            ->where('user_id', $request->user()->id)
            ->latest()
            ->paginate(20);

        return view('notes.index', ['notes' => $notes]);
    }
}`],
  ['kotlin', 'kotlin', `data class Note(val title: String, val tags: List<String> = emptyList())

fun main() {
    val notes = listOf(
        Note("Groceries", listOf("home")),
        Note("Sprint plan", listOf("work", "plan")),
    )
    val byTag = notes.flatMap { note -> note.tags.map { it to note } }
        .groupBy({ it.first }, { it.second })
    byTag.forEach { (tag, list) -> println("$tag: \${list.size}") }
}`],
  ['swift', 'swift', `import Foundation

struct Note: Identifiable, Codable {
    let id: UUID
    var title: String
    var tags: [String]
}

final class NoteStore: ObservableObject {
    @Published private(set) var notes: [Note] = []

    func add(_ title: String) {
        notes.append(Note(id: UUID(), title: title, tags: []))
    }

    func notes(tagged tag: String) -> [Note] {
        notes.filter { $0.tags.contains(tag) }
    }
}`],
  ['csharp', 'csharp', `using System;
using System.Collections.Generic;
using System.Linq;

namespace Notes
{
    public class NoteIndex
    {
        private readonly List<string> _titles = new List<string>();

        public void Add(string title)
        {
            if (string.IsNullOrWhiteSpace(title))
                throw new ArgumentException("title is required", nameof(title));
            _titles.Add(title);
        }

        public IEnumerable<string> StartingWith(string prefix) =>
            _titles.Where(t => t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }
}`],
  ['diff', 'diff', `diff --git a/src/notes.ts b/src/notes.ts
index 3b18e51..a9c2f4d 100644
--- a/src/notes.ts
+++ b/src/notes.ts
@@ -10,7 +10,7 @@ export function title(note: Note): string {
-  return note.title
+  return note.title.trim()
 }
`],
  ['python', 'python-short', `def greet(name):
    if not name:
        return "Hello, stranger"
    return f"Hello, {name}!"

print(greet("Ada"))`],
  ['python', 'python-class', `class Stack:
    def __init__(self):
        self.items = []

    def push(self, item):
        self.items.append(item)

    def pop(self):
        return self.items.pop()`],
  ['javascript', 'js-short', `function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}`],
  ['javascript', 'js-react', `import { useState } from 'react'

export default function Counter() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>{count}</button>
}`],
  ['javascript', 'js-fetch', `const res = await fetch('/api/notes')
const notes = await res.json()
notes.forEach((note) => console.log(note.title))`],
  ['typescript', 'ts-generic', `export async function retry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < times; i++) {
    try {
      return await fn()
    } catch (error) {
      last = error
    }
  }
  throw last
}`],
  ['rust', 'rust-short', `fn main() {
    let words = vec!["apple", "bob", "kayak"];
    for w in &words {
        let rev: String = w.chars().rev().collect();
        println!("{} {}", w, rev == *w);
    }
}`],
  ['go', 'go-short', `func Sum(xs []int) int {
	total := 0
	for _, x := range xs {
		total += x
	}
	return total
}`],
  ['json', 'json-array', `[
  { "id": 1, "title": "Groceries", "done": false },
  { "id": 2, "title": "Call mom", "done": true }
]`],
  ['c', 'c-short', `#include <stdio.h>

int main(void) {
    printf("hello, world\\n");
    return 0;
}`],
  ['cpp', 'cpp-short', `#include <iostream>

int main() {
    std::cout << "hello" << std::endl;
}`],
  ['html', 'html-snippet', `<div class="card">
  <h2>Title</h2>
  <p>Some <strong>bold</strong> text and a <a href="/x">link</a>.</p>
</div>`],
  ['xml', 'xml-config', `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>notes</artifactId>
</project>`],
  ['css', 'css-short', `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  color: #222;
}`],
  ['ruby', 'ruby-short', `def fizzbuzz(n)
  (1..n).each do |i|
    puts i % 15 == 0 ? "FizzBuzz" : i % 3 == 0 ? "Fizz" : i % 5 == 0 ? "Buzz" : i
  end
end`],
  ['php', 'php-short', `<?php
$notes = array_filter($all, fn($n) => $n['done'] === false);
foreach ($notes as $note) {
    echo $note['title'] . PHP_EOL;
}`],
  ['kotlin', 'kotlin-short', `fun greet(name: String?): String {
    val who = name ?: "stranger"
    return "Hello, $who"
}`],
  ['csharp', 'csharp-short', `public class Person
{
    public string Name { get; set; }
    public int Age { get; set; }
}`],
  ['toml', 'toml', `[package]
name = "zn"
version = "0.12.2"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }`],
  ['diff', 'diff-short', `--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,3 @@
-# Old title
+# New title
 Body text`],
  ['python', 'python-async', `import asyncio

async def fetch(session, url):
    async with session.get(url) as resp:
        return await resp.text()

async def main():
    tasks = [fetch(s, u) for u in urls]
    return await asyncio.gather(*tasks)`],
  ['javascript', 'js-class', `class Queue {
  constructor() {
    this.items = []
  }
  enqueue(item) {
    this.items.push(item)
  }
  dequeue() {
    return this.items.shift()
  }
}

module.exports = Queue`],
  ['go', 'go-struct', `type Note struct {
	Title string   \`json:"title"\`
	Tags  []string \`json:"tags"\`
}

func (n *Note) HasTag(tag string) bool {
	for _, t := range n.Tags {
		if t == tag {
			return true
		}
	}
	return false
}`],
  ['ruby', 'ruby-rails', `class NotesController < ApplicationController
  before_action :set_note, only: [:show, :edit]

  def index
    @notes = Note.order(created_at: :desc)
  end

  private

  def set_note
    @note = Note.find(params[:id])
  end
end`],
  ['bash', 'bash-script', `#!/bin/bash
for i in {1..5}; do
  echo "run $i"
  sleep 1
done`],
  ['yaml', 'yaml-k8s', `apiVersion: apps/v1
kind: Deployment
metadata:
  name: zennotes
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: server
          image: adibhanna/zennotes:latest`],
  ['css', 'css-grid', `.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
}
.layout > aside {
  border-right: 1px solid #ddd;
}`],
  ['json', 'json-lines', `{"level":"info","msg":"start"}
{"level":"warn","msg":"slow"}`]
]

/** Short real snippets. Too little for a confident guess, mostly: each may
 *  stay text, but must never be taken for another language. */
export const SHORT: ReadonlyArray<readonly [string, string, string]> = [
  ['python', 'python-pandas', `import pandas as pd

df = pd.read_csv("sales.csv")
monthly = df.groupby("month")["total"].sum()
print(monthly.head())`],
  ['typescript', 'ts-short', `type Point = { x: number; y: number }

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}`],
  ['go', 'go-http', `http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "ok")
})
log.Fatal(http.ListenAndServe(":8080", nil))`],
  ['json', 'json-small', `{"theme": "dark", "fontSize": 14}`],
  ['java', 'java-short', `public static int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}`],
  ['sql', 'sql-short', `CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`],
  ['sql', 'sql-update', `UPDATE notes SET archived = 1 WHERE updated_at < '2025-01-01';`],
  ['yaml', 'yaml-compose', `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: example
    ports:
      - "5432:5432"`],
  ['yaml', 'yaml-front', `title: Weekly review
tags:
  - review
  - weekly
date: 2026-10-29`],
  ['bash', 'bash-short', `cd ~/notes
git add -A
git commit -m "sync"
git push origin main`],
  ['bash', 'bash-loop', `for f in *.png; do
  convert "$f" -resize 50% "small-$f"
done`],
  ['bash', 'shell-prompt', `$ brew install zennotes
$ zn --version
zn 0.12.2`],
  ['swift', 'swift-short', `let names = ["Ada", "Grace"]
for name in names {
    print("Hello, \\(name)")
}`],
  ['scss', 'scss', `$accent: #c33;

.button {
  color: $accent;
  &:hover {
    color: darken($accent, 10%);
  }
}`],
  ['python', 'python-decor', `@app.route("/notes/<int:note_id>")
def show(note_id):
    note = Note.query.get_or_404(note_id)
    return render_template("note.html", note=note)`],
  ['java', 'java-stream', `List<String> titles = notes.stream()
    .filter(n -> !n.isArchived())
    .map(Note::getTitle)
    .sorted()
    .collect(Collectors.toList());`],
  ['sql', 'sql-join', `SELECT u.name, COUNT(*) AS notes
FROM users u
JOIN notes n ON n.user_id = u.id
GROUP BY u.name
ORDER BY notes DESC;`],
  ['rust', 'rust-match', `match command {
    Command::Add(title) => store.add(title)?,
    Command::Remove(id) => store.remove(id)?,
    Command::List => {
        for note in store.list() {
            println!("{}", note.title);
        }
    }
}`]
]

/** Text that is not code: never a guess, at this length or twelve times it. */
export const NOT_CODE: ReadonlyArray<readonly [string, string]> = [
  ['prose', `This is just a paragraph of prose that someone put in a code block
because they wanted it to keep its line breaks. It talks about notes, and
about the weather, and nothing in it is code.`],
  ['path', `/Users/adib/Documents/notes/inbox/2026-10-29.md`],
  ['url', `https://zennotes.org/docs/code-blocks`],
  ['csv', `name,age,city
Ada,36,London
Grace,85,Arlington
Linus,54,Portland`],
  ['log', `2026-10-29 10:42:01 INFO  starting sync
2026-10-29 10:42:02 INFO  pulled 12 changes
2026-10-29 10:42:02 WARN  conflict in inbox/todo.md
2026-10-29 10:42:03 INFO  done in 1.8s`],
  ['ascii table', `+--------+-------+
| name   | count |
+--------+-------+
| notes  |   120 |
| tags   |    34 |
+--------+-------+`],
  ['tree', `zennotes/
├── apps/
│   ├── desktop/
│   └── web/
└── packages/
    └── app-core/`],
  ['numbers', `1 2 3 4 5
6 7 8 9 10`],
  ['shopping', `- eggs
- milk
- bread`],
  ['poem', `Roses are red,
violets are blue,
sugar is sweet,
and so are you.`],
  ['addr', `221B Baker Street
London NW1 6XE`],
  ['kv', `Name: Ada Lovelace
Born: 1815
Known for: Analytical Engine notes`],
  ['recipe', `2 cups flour
1 tsp salt
3/4 cup water
Mix, knead for 10 minutes, rest 1 hour.`],
  ['chat', `Me: are we still on for 7?
Sam: yes! see you there
Me: great`],
  ['math', `a^2 + b^2 = c^2
3^2 + 4^2 = 5^2`],
  ['error', `TypeError: Cannot read properties of undefined (reading 'title')
    at renderNote (app.js:42:17)
    at main (app.js:10:3)`],
  ['keys', `Ctrl+Shift+P
Cmd+K Cmd+S`],
  ['quote', `"The best way to predict the future is to invent it."
- Alan Kay`],
  ['hex', `de ad be ef 00 11 22 33
44 55 66 77 88 99 aa bb`],
  ['todo', `TODO
[x] write spec
[ ] ship it`],
  ['lorem', `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`],
  ['email', `From: ada@example.com
To: grace@example.com
Subject: Notes

Hi Grace, here are the notes from today.`]
]

/** Too small to tell: never a guess. */
export const TINY: ReadonlyArray<readonly [string, string]> = [
  ['tiny word', `hello`],
  ['tiny cmd', `npm install`],
  ['tiny assign', `x = 1`],
  ['one line call', `print("hi")`],
  ['one-line JSON', `{"theme": "dark", "fontSize": 14}`],
  ['one-line SQL', `UPDATE notes SET archived = 1 WHERE updated_at < '2025-01-01';`]
]

/** Code in languages outside the subset, and output that only looks like
 *  code: never a guess. */
export const OTHER_LANGUAGES: ReadonlyArray<readonly [string, string]> = [
  ['haskell', `module Main where

quicksort :: Ord a => [a] -> [a]
quicksort [] = []
quicksort (p:xs) = quicksort lesser ++ [p] ++ quicksort greater
  where
    lesser  = filter (< p) xs
    greater = filter (>= p) xs`],
  ['elixir', `defmodule Greeter do
  def hello(name) do
    "Hello, #{name}"
  end
end`],
  ['makefile', `build:
	go build -o bin/zn ./cmd/zn

test:
	go test ./...`],
  ['nginx', `server {
    listen 80;
    server_name notes.example.com;
    location / {
        proxy_pass http://127.0.0.1:7878;
    }
}`],
  ['lua', `local function greet(name)
  if name == nil then
    return "hello"
  end
  return "hello " .. name
end`],
  ['markdown', `# Title

Some *emphasis* and **bold** text.

- one
- two`],
  ['scala', `object Main extends App {
  case class Note(title: String, tags: List[String])
  val notes = List(Note("a", List("x")), Note("b", Nil))
  notes.filter(_.tags.nonEmpty).foreach(n => println(n.title))
}`],
  ['perl', `my @notes = glob("*.md");
foreach my $file (@notes) {
    open(my $fh, '<', $file) or die "Cannot open $file: $!";
    my $count = () = <$fh>;
    print "$file: $count\\n";
}`],
  ['r', `library(dplyr)
notes <- read.csv("notes.csv")
notes %>%
  group_by(tag) %>%
  summarise(n = n()) %>%
  arrange(desc(n))`],
  ['clojure', `(defn count-tags [notes]
  (->> notes
       (mapcat :tags)
       (frequencies)
       (sort-by val >)))`],
  ['latex', `\\begin{equation}
  E = mc^2
\\end{equation}
\\begin{itemize}
  \\item First
  \\item Second
\\end{itemize}`],
  ['py-traceback', `Traceback (most recent call last):
  File "main.py", line 10, in <module>
    main()
  File "main.py", line 6, in main
    print(notes[3])
IndexError: list index out of range`],
  ['java-trace', `Exception in thread "main" java.lang.NullPointerException
	at com.example.Notes.load(Notes.java:42)
	at com.example.Main.main(Main.java:10)`],
  ['sql-prose', `Please select the items from the list below and update the table
when you are done, then drop me a note with the values you picked.`],
  ['shell-session', `$ npm install
added 214 packages in 3s
$ npm test
> zennotes@2.79.0 test
> vitest run`],
  ['git-log', `commit 8eac8604a1b2
Author: Adib Hanna <adib@example.com>
Date:   Thu Oct 29 11:27:02 2026 -0500

    Test(cloud): the pull-cost check bounds a large vault's change`],
  ['http', `GET /api/notes HTTP/1.1
Host: localhost:7878
Authorization: Bearer abc123
Accept: application/json`],
  ['env', `DATABASE_URL=postgres://localhost/notes
REDIS_URL=redis://localhost:6379
DEBUG=true`],
  ['markdown-table', `| Name | Count |
|------|-------|
| a    | 1     |
| b    | 2     |`],
  ['pseudo', `function findMax(list)
    max <- list[0]
    for each item in list
        if item > max then max <- item
    return max`],
  ['regex-list', `^\\d{3}-\\d{4}$
^[A-Z][a-z]+$
\\b(foo|bar)\\b`],
  ['outline', `1. Introduction
   1.1 Background
   1.2 Goals
2. Design
   2.1 Detection`],
  ['meeting', `Attendees: Ada, Grace, Linus
Agenda:
  - review the release
  - plan next sprint
Decisions: ship on Friday`],
  ['ini-nosection', `name = zen
version = 2
debug = true`],
  ['csv-semi', `id;title;done
1;Groceries;false
2;Call mom;true`],
  ['graphql', `query Notes($tag: String!) {
  notes(tag: $tag) {
    id
    title
  }
}`],
  ['proto', `syntax = "proto3";
message Note {
  string title = 1;
  repeated string tags = 2;
}`],
  ['dockerfile', `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "server.js"]`]
]
