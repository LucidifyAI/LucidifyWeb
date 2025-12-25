import json
dump = json.load(open("yasa_model_dump.json","r",encoding="utf-8"))
with open("yasa_model_dump_embedded.js","w",encoding="utf-8") as f:
    f.write("window.__YASA_MODEL_DUMP__ = ")
    json.dump(dump, f)
    f.write(";")