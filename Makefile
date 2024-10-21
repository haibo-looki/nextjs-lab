API_PROTO_FILES=$(shell find protos -name *.proto)

.PHONY: proto
# generate proto
proto:
	rm -rf ./protos/**/*.ts
	pnpm exec protoc \
	    --ts_out protos \
	    --ts_opt long_type_string \
	    --ts_opt optimize_code_size \
	    --proto_path protos \
	    $(API_PROTO_FILES)
