# Writing a game

Each game is a JSON file in this folder, listed in `index.json` (`id` = file name without `.json`).

```json
{
  "title": "My Game",
  "players": ["Mikey", "June", "Mom"],
  "points": 100,
  "categories": [
    { "name": "Category", "questions": [
      { "q": "Mikey easy",  "a": "answer" },
      { "q": "Mikey medium","a": "answer" },
      { "q": "Mikey hard",  "a": "answer" },
      { "q": "June 1 ..." }, { "q": "June 2" }, { "q": "June 3" },
      { "q": "Mom 1" },      { "q": "Mom 2" },  { "q": "Mom 3" }
    ]}
  ]
}
```

Questions are split evenly among players in order (same layout as the spreadsheet rows).

Optional fields per question:
- `image`: picture clue URL
- `video`: video clue — a YouTube link or a direct .mp4/.webm URL; `start` / `end` in seconds clip it
- `audio`: audio clue URL
- `answerImage` / `answerVideo` / `answerAudio`: shown when the answer is revealed
- `points`: override the default points for that question

Keyboard (host): Space = reveal, Y = correct, N = wrong, Esc = back to board.
