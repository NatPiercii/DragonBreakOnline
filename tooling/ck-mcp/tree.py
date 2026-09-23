import struct

def parse(buf):
    """-> (header_bytes, nodes). node = ['G', hdr24, children] or ['R', hdr24, body]"""
    hsize=struct.unpack_from('<I',buf,4)[0]
    head=buf[:24+hsize]
    def walk(pos,end):
        out=[]
        while pos<end:
            sig=buf[pos:pos+4]; size=struct.unpack_from('<I',buf,pos+4)[0]
            if sig==b'GRUP':
                gend=pos+size
                out.append(['G',bytearray(buf[pos:pos+24]),walk(pos+24,gend)])
                pos=gend
            else:
                body=buf[pos+24:pos+24+size]
                out.append(['R',bytearray(buf[pos:pos+24]),bytearray(body)])
                pos+=24+size
        return out
    return bytearray(head), walk(24+hsize,len(buf))

def serialize(head,nodes):
    out=bytearray(head)
    def emit(ns,dst):
        for n in ns:
            if n[0]=='R':
                struct.pack_into('<I',n[1],4,len(n[2]))
                dst+=n[1]; dst+=n[2]
            else:
                inner=bytearray()
                emit(n[2],inner)
                struct.pack_into('<I',n[1],4,len(inner)+24)
                dst+=n[1]; dst+=inner
    emit(nodes,out)
    return bytes(out)

def walk_records(nodes):
    for n in nodes:
        if n[0]=='R': yield n
        else:
            for r in walk_records(n[2]): yield r
