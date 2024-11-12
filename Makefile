PROTO_PATH=./protos
GEN_PATH=./protos

.PHONY: proto
# generate proto
proto:
	rm -rf $(GEN_PATH)/*.ts
	pnpm exec protoc \
	    --ts_out $(GEN_PATH) \
	    --ts_opt long_type_string \
	    --ts_opt optimize_code_size \
	    --proto_path $(PROTO_PATH) \
	    $(shell find $(PROTO_PATH) -name "*.proto")
