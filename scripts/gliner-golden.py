# Golden fixtures for the on-device semantic recognizer, from the reference GLiNER implementation.
#
# The TypeScript port (src/main/privacy/semantic) must split words, tokenize, build inputs and decode exactly as
# the Python package does. This script records what the reference produces for the evaluation corpus and a set of
# Unicode edge cases; test/privacy/semantic/golden.test.ts compares against it when the model files are present.
#
#   python3 -m venv .venv && .venv/bin/pip install gliner onnxruntime
#   npx tsx -e "import { CORPUS } from './test/privacy/corpus'; process.stdout.write(JSON.stringify(CORPUS))" > /tmp/corpus.json
#   .venv/bin/python scripts/gliner-golden.py <model dir> /tmp/corpus.json test/privacy/fixtures/gliner-golden.json
#
# It also writes the tokenizer's SentencePiece character map to test/privacy/fixtures/nmt-nfkc.charsmap, with what the
# Rust implementation makes of a set of strings, so the normalization port is tested even without the model files.
#
# <model dir> holds the files listed in the manifest (src/main/privacy/semantic/manifest.ts), as the app installs
# them: gliner_config.json, tokenizer.json, onnx/model_quint8.onnx.
#
# The tokenizer is the one tokenizer.json defines, run by the Rust tokenizers library. transformers 5 replaces the
# normalizer of DeBERTa-v2 tokenizers with its own (NFC and whitespace rules); the model was trained with transformers
# 4.55 and the file's SentencePiece normalization, which is what the app implements, so that is what is pinned here.
import base64
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import gliner
import onnxruntime
import tokenizers
import transformers
from gliner import GLiNER
from transformers import PreTrainedTokenizerFast

model_dir, corpus_path, out_path = sys.argv[1:4]

# Kept in step with the manifest: the labels, in prompt order, and the threshold.
LABELS = [
    "name",
    "location address",
    "location city",
    "location state",
    "location country",
    "organization",
    "organization medical facility",
    "password",
    "phone number",
    "date",
]
THRESHOLD = 0.5

EDGE_CASES = [
    "Zoë Dupont lives at 3 rue de la Paix.",
    "Zoe\u0308 Dupont (decomposed) called.",
    "ﬁnance ﬁle for Mañana",
    "ＡＢＣ\u3000１２３ fullwidth",
    "Call \U0001F469\u200d\U0001F4BB Jane at 555-0100 \U0001F44D",
    "اسمي أحمد وأعيش في دبي",
    "मेरा नाम राहुल शर्मा है",
    "田中さんに電話してください",
    "Name:\tJane Roe\nPhone:\t555-0100\r\n",
    "Jane\u200bDoe and\xa0John\xa0Roe",
    "\u0007bell and \u001fseparator",
    "O'Brien-Smith didn't e-mail_address",
    "Totals: 1,234.56 and $5,000 on 2024-03-02",
    "a" * 60 + " is a long word",
    "co\xadoperate with Ïñţëŕñåţîöñåļ",
    "İstanbul, Straße, Αθήνα, Москва",
    "  leading and trailing spaces  ",
    "x",
    "!!!",
    "²³ superscripts and ½ fractions",
    "Ｔｏｋｙｏ Ｔｏｗｅｒ",
    "Jack’s phone is 867\u20115309",
]

NORMALIZER_CASES = [
    "\ufb01\ufb02\ufb03 ligatures",
    "\u2460\u2461 \u216b \u33a1 \u2121 \u00bd",
    "\u1100\u1161\u11a8 jamo and \uac01",
    "\ufeb3\ufeb4 presentation forms",
    "\u2603\ufe0f snowman, \U0001F1EF\U0001F1F5 flag",
    "tab\tnew\nline\r\x0bvt\x0cff",
    "\ufeffbom \u00a0nbsp \u00adshy \u2028ls \u2029ps",
    "\u0000nul\u0001soh\u001bescape\u007fdel\u0085nel",
    "A\u030a \u00c5 \u212b angstroms",
    "\uff76\uff9e halfwidth katakana",
    "\U0001D400\U0001D41A math bold",
    "e\u0301\u0327 stacked marks",
]

corpus = json.load(open(corpus_path))
texts = [k["text"] for k in corpus] + EDGE_CASES

model = GLiNER.from_pretrained(model_dir, local_files_only=True, runtime="onnxruntime", runtime_model_file="onnx/model_quint8.onnx")
proc = model.data_processor
proc.transformer_tokenizer = PreTrainedTokenizerFast(
    tokenizer_object=tokenizers.Tokenizer.from_file(f"{model_dir}/tokenizer.json"),
    unk_token="[UNK]",
    pad_token="[PAD]",
    cls_token="[CLS]",
    sep_token="[SEP]",
    mask_token="[MASK]",
)
assert "Precompiled" in str(proc.transformer_tokenizer.backend_tokenizer.normalizer), "the file's normalizer must be in use"


cases = []
for text in texts:
    words = list(proc.words_splitter(text))
    tokens = [w for w, _, _ in words]
    tokenized = proc.tokenize_inputs([tokens], LABELS)
    entities = model.predict_entities(text, LABELS, threshold=THRESHOLD, flat_ner=True, multi_label=False)
    cases.append(
        {
            "text": text,
            "words": [[w, s, e] for w, s, e in words],
            "input_ids": tokenized["input_ids"][0].tolist(),
            "words_mask": tokenized["words_mask"][0].tolist(),
            "entities": [
                {"start": e["start"], "end": e["end"], "text": e["text"], "label": e["label"], "score": round(float(e["score"]), 6)}
                for e in entities
            ],
        }
    )

tokenizer_json = json.load(open(f"{model_dir}/tokenizer.json"))
charsmap = base64.b64decode(tokenizer_json["normalizer"]["normalizers"][1]["precompiled_charsmap"])
precompiled = tokenizers.normalizers.Precompiled(charsmap)
with open(os.path.join(os.path.dirname(out_path), "nmt-nfkc.charsmap"), "wb") as f:
    f.write(charsmap)

json.dump(
    {
        "about": "Generated by scripts/gliner-golden.py from the reference GLiNER implementation. Offsets are code points.",
        "reference": {"gliner": gliner.__version__, "transformers": transformers.__version__, "tokenizers": tokenizers.__version__, "onnxruntime": onnxruntime.__version__},
        "labels": LABELS,
        "threshold": THRESHOLD,
        "cases": cases,
        "normalizer": [[t, precompiled.normalize_str(t)] for t in NORMALIZER_CASES + texts],
    },
    open(out_path, "w"),
    ensure_ascii=False,
    indent=1,
)
print(f"{len(cases)} cases -> {out_path}")
