# Demo songs

Public-domain songs as UltraStar charts, so the app has something to sing without importing
anything. No audio is included; the app plays its own reference tones. The list leads with
songs a crowd joins in on (a party, a campfire, New Year's Eve); the hymns, carols and
classical tunes follow as "Classics".

"Public domain in the United States" here means the tune and the words were published
before 1931, so anyone in the US may copy and perform them; it does not cover other
countries, whose rules differ, and it never covers a recording of the song, which has its
own, much later copyright. That is also why there is no modern pop here: a song has to be
that old before it can be bundled.

Two charts were written out by hand. The rest are made by `tools/build-demo-songs.mjs` from
a score that is itself free to use, fetched from that score's official home and pinned by
its sha256: a CC0 or public-domain score, or a score written inside a Wikipedia article.
Nothing is transcribed from a recording, no chart is copied from a karaoke site, and each
chart keeps only the vocal line with its best-known verse and refrain.
To rebuild: `node tools/build-demo-songs.mjs --fetch` (the sources go to the git-ignored
`tools/.cache/demo-songs/`); `npm test` then checks that the rebuilt charts are these files
byte for byte, and that every word in a chart is in that chart's own source.

**Licence of the charts made from Wikipedia.** Wikipedia's text, its scores included, is
under CC BY-SA 4.0. A chart made from such a score is an adaptation of it, so those charts
(the ones whose source below says "Wikipedia contributors") are shared under the same
licence, CC BY-SA 4.0, and each names its article and revision in its `#SOURCE` line and
below. That covers the charts only; the rest of this project is not an adaptation of them.
The songs themselves stay public domain. The other built charts come from CC0 and
public-domain scores and carry no such condition.

<!-- demo-songs:begin (written by tools/build-demo-songs.mjs; do not edit by hand) -->
### Sing-along favourites

| File | Song | Music | Words | Chart made from | Why it is public domain in the US |
| --- | --- | --- | --- | --- | --- |
| `auld-lang-syne.txt` | Auld Lang Syne | Scottish traditional tune | Robert Burns (died 1796), 1788, after an older song | Wikipedia contributors, "Auld Lang Syne" (en.wikipedia.org, revision 1378217057), CC BY-SA 4.0 | Written in 1788 and published in 1796 in the "Scots Musical Museum": published before 1931. |
| `my-bonnie.txt` | My Bonnie Lies over the Ocean | Scottish traditional; in print by 1881 | Scottish traditional; in print by 1881 | Wikipedia contributors, "My Bonnie Lies over the Ocean" (en.wikipedia.org, revision 1371358716), CC BY-SA 4.0 | Tune and words printed in "Students' Songs" in 1881: published before 1931. |
| `hava-nagila.txt` | Hava Nagila | Hasidic melody, set down by Abraham Zvi Idelsohn (died 1938) in 1915 | Abraham Zvi Idelsohn (died 1938), 1918 | Wikipedia contributors, "Hava Nagila" (en.wikipedia.org, revision 1377482510), CC BY-SA 4.0 | First published in 1922 in a Hebrew song collection: published before 1931. |
| `drunken-sailor.txt` | Drunken Sailor | Sea shanty, traditional | Sea shanty, traditional | Wikipedia contributors, "Drunken Sailor" (de.wikipedia.org, revision 260438552), CC BY-SA 4.0 | Tune and these words printed in "The Shanty Book, Part I" in 1921: published before 1931. |
| `happy-birthday.txt` | Happy Birthday to You | Patty Hill (died 1946) and Mildred J. Hill (died 1916), "Good Morning to All", 1893 | Unknown; the birthday words to that tune, in print by 1911 | Wikipedia contributors, "Happy Birthday to You" (en.wikipedia.org, revision 1369481119), CC BY-SA 4.0 | Tune published in 1893 and the birthday words by 1911: published before 1931. |
| `alouette.txt` | Alouette | French-Canadian traditional, first printed 1879 | French-Canadian traditional, first printed 1879 | Wikipedia contributors, "Alouette (song)" (en.wikipedia.org, revision 1365593225), CC BY-SA 4.0 | First printed in 1879 in a McGill College song book: published before 1931. |
| `red-river-valley.txt` | Red River Valley | North American traditional; in print by 1927 | North American traditional; in print by 1927 | Wikipedia contributors, "Red River Valley (song)" (en.wikipedia.org, revision 1378721571), CC BY-SA 4.0 | Tune and these words printed in "The American Songbag" in 1927: published before 1931. |
| `skye-boat-song.txt` | The Skye Boat Song | Scottish traditional air, first published 1884 | Harold Boulton (died 1935), 1884 | Wikipedia contributors, "The Skye Boat Song" (en.wikipedia.org, revision 1373646816), CC BY-SA 4.0 | First published in 1884: published before 1931. |
| `pokarekare-ana.txt` | Pōkarekare Ana | New Zealand, a love song from about 1914, arranged by Paraire Tomoana (died 1946) in 1917 | New Zealand, a love song from about 1914; these words by Paraire Tomoana (died 1946), 1917 | Wikipedia contributors, "Pōkarekare Ana" (en.wikipedia.org, revision 1364390961), CC BY-SA 4.0 | Sheet music with these words published in Auckland in 1926: published before 1931. |
| `gaudeamus-igitur.txt` | Gaudeamus igitur | Unknown; a student song, the tune first printed in 1782 | Unknown; this Latin text published by Christian Wilhelm Kindleben in 1781 | Wikipedia contributors, "Gaudeamus igitur" (en.wikipedia.org, revision 1374846056), CC BY-SA 4.0 | Words published in 1781 and tune in 1782, and in American college song books by 1876: published before 1931. |

### Classics

| File | Song | Music | Words | Chart made from | Why it is public domain in the US |
| --- | --- | --- | --- | --- | --- |
| `twinkle-twinkle.txt` | Twinkle Twinkle Little Star | French traditional, "Ah! vous dirai-je, maman" (printed 1761) | Jane Taylor (died 1824), "The Star", 1806 | Written out by hand for this project (no score copied) | Tune printed in 1761 and words in 1806: published before 1931. |
| `ode-to-joy.txt` | Ode to Joy | Ludwig van Beethoven (died 1827), Symphony No. 9, 1824 (first 8 bars of the theme) | Friedrich Schiller (died 1805), "An die Freude", 1785 | Written out by hand for this project (no score copied) | Tune published in 1826 and words in 1786: published before 1931. |
| `amazing-grace.txt` | Amazing Grace | American hymn tune "New Britain", printed 1829; this form from "Virginia Harmony", 1831 | John Newton (died 1807), "Olney Hymns", 1779 | Open Hymnal Project, Public domain | Words printed in 1779 and tune in 1831: published before 1931. |
| `joy-to-the-world.txt` | Joy to the World | Lowell Mason (died 1872), tune "Antioch", 1836, after phrases from Handel's "Messiah" | Isaac Watts (died 1748), 1719 | Open Hymnal Project, Public domain | Words printed in 1719 and tune in 1836: published before 1931. |
| `the-first-noel.txt` | The First Noel | English traditional carol, first printed 1833 | English traditional carol, first printed 1823 | Open Hymnal Project, Public domain | Words printed in 1823 and tune in 1833: published before 1931. |
| `home-sweet-home.txt` | Home, Sweet Home | Henry Bishop (died 1855), from the opera "Clari", 1823 | John Howard Payne (died 1852), 1823 | OpenScore Lieder Corpus, CC0 1.0 Universal | Published in 1823: published before 1931. |
| `brahms-lullaby.txt` | Wiegenlied (Brahms's Lullaby) | Johannes Brahms (died 1897), Wiegenlied, Op. 49 No. 4, 1868 | German traditional, from "Des Knaben Wunderhorn", 1808 | OpenScore Lieder Corpus, CC0 1.0 Universal | Words printed in 1808 and song in 1868: published before 1931. |
| `aloha-oe.txt` | Aloha ʻOe (chorus) | Liliʻuokalani (died 1917), written 1878, published 1884 | Liliʻuokalani (died 1917), 1878, with her own English lines | OpenScore Lieder Corpus, CC0 1.0 Universal | Published in 1884: published before 1931. |

### Sources

- `auld-lang-syne.txt`: <https://en.wikipedia.org/w/index.php?title=Auld_Lang_Syne&oldid=1378217057&action=raw>
  - sha256 `e5346154741d7a6d92e9c9b6cc91d6012e3467b6bf01db7be6e738f8bc69c3bb`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=Auld_Lang_Syne&oldid=1378217057>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Auld Lang Syne" (en.wikipedia.org, revision 1378217057), <https://en.wikipedia.org/w/index.php?title=Auld_Lang_Syne&oldid=1378217057>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/b/h/bhvzoz2uvr81xlvvye558oppu8x6fkn/bhvzoz2u.midi> (sha256 `71f370f7cad48cf742fab198b2329613ba7094ebc6990e44e9089ba6c22356cf`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://www.bbc.co.uk/arts/robertburns/works/auld_lang_syne/>: BBC, "Robert Burns: Auld Lang Syne": written in 1788, published in James Johnson's Scots Musical Museum in 1796
- `my-bonnie.txt`: <https://en.wikipedia.org/w/index.php?title=My_Bonnie_Lies_over_the_Ocean&oldid=1371358716&action=raw>
  - sha256 `abd4965d01921c0dbc5e99abe647232032b5ec45a552e06f3ceebbadbdd28b22`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=My_Bonnie_Lies_over_the_Ocean&oldid=1371358716>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "My Bonnie Lies over the Ocean" (en.wikipedia.org, revision 1371358716), <https://en.wikipedia.org/w/index.php?title=My_Bonnie_Lies_over_the_Ocean&oldid=1371358716>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/9/w/9w7jprcfak19ojdxjialdph87yo56lx/9w7jprcf.midi> (sha256 `735b0f05b11458ac324fe52700233cc82912818586cfb2993499331c7269c96f`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://archive.org/details/studentssongsco00hillgoog>: William H. Hills, "Students' Songs" (Cambridge, Massachusetts): "My Bonnie", page 29, among pages marked "Copyright, 1881, by Wm. H. Hills"
- `hava-nagila.txt`: <https://en.wikipedia.org/w/index.php?title=Hava_Nagila&oldid=1377482510&action=raw>
  - sha256 `76fddcd81106edd715fa508b60bf85953ecd57e733cbeb132f41b01d4b77d940`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=Hava_Nagila&oldid=1377482510>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Hava Nagila" (en.wikipedia.org, revision 1377482510), <https://en.wikipedia.org/w/index.php?title=Hava_Nagila&oldid=1377482510>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/o/b/obgi5fy20lvvu8qoz8l6eynyegu5fw5/obgi5fy2.midi> (sha256 `5e7b1a8fa197581ec2d0e363a6d7ac22e1846c242706d13b13a4ccf832c9fe53`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://www.myjewishlearning.com/article/hava-nagilas-long-strange-trip/>: My Jewish Learning, "Hava Nagila's Long, Strange Trip": Idelsohn transcribed the melody in 1915, chose it for a 1918 concert and "first published the song in a Hebrew song collection in 1922"
- `drunken-sailor.txt`: <https://de.wikipedia.org/w/index.php?title=Drunken_Sailor&oldid=260438552&action=raw>
  - sha256 `c9f9bb32502b88b9fd5f4b88634c18d9d8956a9445b461206a4dc54ef73989b5`, retrieved 2026-10-13
  - licence as stated at <https://de.wikipedia.org/w/index.php?title=Drunken_Sailor&oldid=260438552>: "Der Text ist unter der Lizenz „Creative-Commons Namensnennung – Weitergabe unter gleichen Bedingungen“ verfügbar"
  - attribution: Wikipedia contributors, "Drunken Sailor" (de.wikipedia.org, revision 260438552), <https://de.wikipedia.org/w/index.php?title=Drunken_Sailor&oldid=260438552>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/3/n/3n9qp69t11dork9cg1sjg31o798qbjv/3n9qp69t.midi> (sha256 `3393d6010ab27dac6db87dcf59d8ed7c3f86f70d69a0e275b019061bde8722d9`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://www.gutenberg.org/ebooks/20774>: Richard Runciman Terry, "The Shanty Book, Part I" (London: J. Curwen & Sons, copyright 1921), no. 14, "What shall we do with the drunken sailor?" (Project Gutenberg ebook 20774)
- `happy-birthday.txt`: <https://en.wikipedia.org/w/index.php?title=Happy_Birthday_to_You&oldid=1369481119&action=raw>
  - sha256 `ef7960fbf90a0fa074586d3f135d666667dfd705e2943bdac2d60a8ab1a0daa0`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=Happy_Birthday_to_You&oldid=1369481119>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Happy Birthday to You" (en.wikipedia.org, revision 1369481119), <https://en.wikipedia.org/w/index.php?title=Happy_Birthday_to_You&oldid=1369481119>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/m/5/m56j3xf7slsacrgmc6sw53kvmz1nbba/m56j3xf7.midi> (sha256 `e69b4ddaa1f430d6dfd2fceda09ce9097d7036e0f5aec106004dd39b71cb271a`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://en.wikisource.org/wiki/The_Elementary_Worker_and_his_Work/Chapter_5>: Alice Jacobs and Ermina C. Lincoln, "The Elementary Worker and His Work" (1911), chapter 5, which prints "Happy Birthday" and "Good Morning" from the Hill sisters' song book (Wikisource transcription); the tune's 1893 date is from the Wikipedia article, which cites "Song Stories for the Kindergarten"
- `alouette.txt`: <https://en.wikipedia.org/w/index.php?title=Alouette_(song)&oldid=1365593225&action=raw>
  - sha256 `caf56160896a8988d3735dec3b9838a56edd23ac268434c5a9a378538eb846b5`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=Alouette_(song)&oldid=1365593225>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Alouette (song)" (en.wikipedia.org, revision 1365593225), <https://en.wikipedia.org/w/index.php?title=Alouette_(song)&oldid=1365593225>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/b/y/bydos9tvbn3v6h6i771owl08rbbdfm3/bydos9tv.midi> (sha256 `083fcfe5506b8656fd2e941c7ee58a6eba1e4ee63df6a5e9d2f67caa6e3772b9`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://thecanadianencyclopedia.ca/en/article/quotalouettequot-emc>: The Canadian Encyclopedia, "Alouette!": it "appeared in A Pocket Song Book for the Use of Students and Graduates of McGill College (Montreal 1879)"
- `red-river-valley.txt`: <https://en.wikipedia.org/w/index.php?title=Red_River_Valley_(song)&oldid=1378721571&action=raw>
  - sha256 `d5f1d9263a8ffc3b530d5f0f040990478f1c4c566bfa33778f2b59700a29a564`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=Red_River_Valley_(song)&oldid=1378721571>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Red River Valley (song)" (en.wikipedia.org, revision 1378721571), <https://en.wikipedia.org/w/index.php?title=Red_River_Valley_(song)&oldid=1378721571>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/8/j/8j6ovda27hij03hgudacf0fcngod1hs/8j6ovda2.midi> (sha256 `243f7365dda4b9f8cd9cbd6a178e67eb5c3a98b4d07e9b5d66f2e7903ea0b9a6`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://archive.org/details/americansongbag029895mbp/page/n157>: Carl Sandburg, "The American Songbag" (New York: Harcourt, Brace, 1927), page 130, "Red River Valley", with this verse
- `skye-boat-song.txt`: <https://en.wikipedia.org/w/index.php?title=The_Skye_Boat_Song&oldid=1373646816&action=raw>
  - sha256 `dce15e850ef9b022d5dadb33accc6e1c18bd3164b37766676a1b84f76f031b15`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=The_Skye_Boat_Song&oldid=1373646816>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "The Skye Boat Song" (en.wikipedia.org, revision 1373646816), <https://en.wikipedia.org/w/index.php?title=The_Skye_Boat_Song&oldid=1373646816>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/d/n/dnq6v48glmm7chsl82cak8aler01976/dnq6v48g.midi> (sha256 `1696e0a3aa8075ca6f32b9cd18ee6f411e320a0e29cf7d4b6d20a40691126651`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://www.historyextra.com/period/georgian/10-things-you-probably-didnt-know-about-bonnie-prince-charlie-and-the-jacobites/>: HistoryExtra (BBC History Magazine), "10 things you probably didn't know about Bonnie Prince Charlie and the Jacobites": words by Sir Harold Edwin Boulton (1859 to 1935), "first published in 1884"
- `pokarekare-ana.txt`: <https://en.wikipedia.org/w/index.php?title=P%C5%8Dkarekare_Ana&oldid=1364390961&action=raw>
  - sha256 `6f08e37d024f4e6524c963842855f6260daf47c11eaed825a04005b256d14d5e`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=P%C5%8Dkarekare_Ana&oldid=1364390961>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Pōkarekare Ana" (en.wikipedia.org, revision 1364390961), <https://en.wikipedia.org/w/index.php?title=P%C5%8Dkarekare_Ana&oldid=1364390961>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/c/l/clmz8s0r7svvli55lrzcz7tcifqhbyr/clmz8s0r.midi> (sha256 `14125e333c0d6480fb06a7d70ecc307a600c948d93f05368b00e3a4857f03f1d`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <http://folksong.org.nz/pokarekare/index3.html>: New Zealand Folk Song, "Pōkarekare Ana": arranged by P. H. Tomoana in 1917 with the "Ngā wai o Waiapu" words; sheet music "Pokare Kare" published by A. Eady and Co, Auckland, in 1926
- `gaudeamus-igitur.txt`: <https://en.wikipedia.org/w/index.php?title=Gaudeamus_igitur&oldid=1374846056&action=raw>
  - sha256 `339012f4820d385fcc4ebf7819bd36f1bb9a6e95d518156bd7f90b425ccd35d0`, retrieved 2026-10-13
  - licence as stated at <https://en.wikipedia.org/w/index.php?title=Gaudeamus_igitur&oldid=1374846056>: "Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply."
  - attribution: Wikipedia contributors, "Gaudeamus igitur" (en.wikipedia.org, revision 1374846056), <https://en.wikipedia.org/w/index.php?title=Gaudeamus_igitur&oldid=1374846056>. The chart is an adaptation of the score in that article (the vocal line and its words, turned into UltraStar notes) and is shared under CC BY-SA 4.0, as that licence requires.
  - melody checked note by note against <https://upload.wikimedia.org/score/t/h/thdloiov0an2gby5hwikr4kee69wplv/thdloiov.midi> (sha256 `ebe8b839dc47f4210b7b968901d6785f84199d8ac08ac446fc22799e75b68f13`), the MIDI file Wikimedia made from the same score
  - first publication, as read at <https://archive.org/details/carminacollegens00wait/page/n73/mode/2up>: Henry R. Waite (editor), "Carmina Collegensia" (Boston: Oliver Ditson, copyright 1876), which prints the Latin song; the years 1781 and 1782 are from the Wikipedia article, which cites James J. Fuld, "The Book of World-Famous Music"
- `amazing-grace.txt`: <http://openhymnal.org/Midi/Amazing_Grace-New_Britain.mid>
  - sha256 `78e0ec32c4e2111d544685f28def8ea01c42987004672551adc5df44b26b73c9`, retrieved 2026-10-12
  - licence as stated at <http://openhymnal.org/Abc/Amazing_Grace-New_Britain.abc>: "copyright: public domain. This score is a part of the Open Hymnal Project, 2006 Revision."
  - words checked against <http://openhymnal.org/Abc/Amazing_Grace-New_Britain.abc> (sha256 `1c5a62eae58411a00e7dc97fb9bb7a15d7c1cef9e4d04b3525754ec5cf0a261f`)
- `joy-to-the-world.txt`: <http://openhymnal.org/Midi/Joy_To_The_World-Antioch.mid>
  - sha256 `3815241fcac262b137c5aa2eb63c7864157a4d30c825159e22ebe9ed774e1eec`, retrieved 2026-10-12
  - licence as stated at <http://openhymnal.org/Abc/Joy_To_The_World-Antioch.abc>: "copyright: public domain. This score is a part of the Open Hymnal Project, 2005 Revision."
  - words checked against <http://openhymnal.org/Abc/Joy_To_The_World-Antioch.abc> (sha256 `7ff9d5aacf3923924af34cf5494caa66c1d207e1c8e0e95dcfa621e3b37f16b7`)
- `the-first-noel.txt`: <http://openhymnal.org/Midi/The_First_Noel-The_First_Noel.mid>
  - sha256 `8e6cb43bf67deaa4df1b1fe1957f5dfde0ed1f25b959650e5ef79564debd5915`, retrieved 2026-10-12
  - licence as stated at <http://openhymnal.org/Abc/The_First_Noel-The_First_Noel.abc>: "copyright: public domain. This score is a part of the Open Hymnal Project, 2006 Revision."
  - words checked against <http://openhymnal.org/Abc/The_First_Noel-The_First_Noel.abc> (sha256 `0b72382d6b764dbcff0fc5e495a335fc5e364867fe10e6aa45b0ee5dc75f51d4`)
- `home-sweet-home.txt`: <https://raw.githubusercontent.com/OpenScore/Lieder/38c5db510224d9facdc4b08d741fc788cfb58ea8/scores/Bishop%2C_Henry/_/Home%2C_Sweet_Home/lc6486038.mxl>
  - sha256 `6553766472bfc67aca1fde73b26b9db2505d191ff75d670f882d8630ade3305b`, retrieved 2026-10-12
  - licence as stated at <https://github.com/OpenScore/Lieder/blob/38c5db510224d9facdc4b08d741fc788cfb58ea8/README.md>: "These scores are released under Creative Commons Zero (CC0). See LICENSE.txt."
- `brahms-lullaby.txt`: <https://raw.githubusercontent.com/OpenScore/Lieder/38c5db510224d9facdc4b08d741fc788cfb58ea8/scores/Brahms%2C_Johannes/5_Lieder%2C_Op.49/4_Wiegenlied/lc5701612.mxl>
  - sha256 `5867b883ba1d159f234a3764a0f3f467afdd78cf6ee4698bca17d52d3a4f65db`, retrieved 2026-10-12
  - licence as stated at <https://github.com/OpenScore/Lieder/blob/38c5db510224d9facdc4b08d741fc788cfb58ea8/README.md>: "These scores are released under Creative Commons Zero (CC0). See LICENSE.txt."
- `aloha-oe.txt`: <https://raw.githubusercontent.com/OpenScore/Lieder/38c5db510224d9facdc4b08d741fc788cfb58ea8/scores/Liliuokalani%2C_Queen_of_the_Hawaiian_Islands/_/Aloha_Oe/lc6650166.mxl>
  - sha256 `b195ae477a10cbaee281d9b728cac001ae1d50fe4527078ccae14092eee4936c`, retrieved 2026-10-12
  - licence as stated at <https://github.com/OpenScore/Lieder/blob/38c5db510224d9facdc4b08d741fc788cfb58ea8/README.md>: "These scores are released under Creative Commons Zero (CC0). See LICENSE.txt."
<!-- demo-songs:end -->

Each built chart repeats these facts in its header (`#COMPOSER`, `#LYRICIST`, `#SOURCE`,
`#SOURCESHA256`, `#LICENSE`, `#PUBLICDOMAIN`). The words are spelt as the source score
spells them. The built charts stay in the key of their source; transpose in the app to fit
your range. A space at the start of a syllable marks the start of a new word, and `~`
carries the syllable before it on to another note.

Each melody is checked by a second route. A chart from a Wikipedia score must agree, note
for note, with the MIDI file that Wikimedia's own music engraver made from the same score
(a list of notes, not a recording); the hymn charts are checked against the hymnal's own
words file. The build stops if they disagree.

To add a song, add an entry to `SONGS` in the build script. It needs a score with a CC0,
public-domain or Wikipedia (CC BY-SA 4.0) licence, a tune and words published before 1931,
and a place where that year can be read; if any is missing, leave the song out.

### Looked at and left out

- "Waltzing Matilda", "Streets of Laredo", "The Wild Colonial Boy": the tune spans 17
  semitones, more than the 14 a demo chart may span.
- "Wellerman": first published in 1973, so not public domain.
- "Bella ciao", "Guantanamera", "The Wheels on the Bus", "Michael, Row the Boat Ashore" (the
  tune sung today): words or tune published after 1930, or not shown to be earlier.
- "When the Saints Go Marching In": the only free score is in a notation Wikimedia no longer
  renders, so there is no second route for the melody, and no pre-1931 print was found.
- "Botany Bay", "Las Mañanitas", "La Cucaracha" (its verse): the year the words were first
  published could not be read at a source.
- "For He's a Jolly Good Fellow", "Row, Row, Row Your Boat", "Aura Lea", "On Top of Old
  Smoky", "The Sidewalks of New York", "Battle Hymn of the Republic": the only free score is
  a fragment shorter than 20 seconds.
- "Take Me Out to the Ball Game", "Daisy Bell", "Jingle Bells", "Oh! Susanna", "Clementine"
  and the jazz-age standards that became public domain by 2026: no score with words under a
  free licence was found at OpenScore, Wikipedia, Wikisource or the Mutopia Project.
